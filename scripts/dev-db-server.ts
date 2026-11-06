// npm run dev:db — local libSQL bridge for `wrangler dev`.
//
// Inside workerd, `@libsql/client` is the web build and cannot open `file:` URLs. This script
// serves the local SQLite file (default local.db) over the Hrana-over-HTTP v2 JSON protocol
// that the web client speaks, so .dev.vars can use TURSO_DATABASE_URL=http://127.0.0.1:8080.
// Dev only: no auth, binds to 127.0.0.1.
//
//   DEV_DB_FILE=local.db DEV_DB_PORT=8080 npm run dev:db
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createClient, type InValue, type ResultSet, type Transaction } from '@libsql/client'
import { randomBytes } from 'node:crypto'

const file = process.env.DEV_DB_FILE || 'local.db'
const port = Number(process.env.DEV_DB_PORT || 8080)
const client = createClient({ url: `file:${file}`, intMode: 'bigint' })

type HValue =
  | { type: 'null' }
  | { type: 'integer'; value: string }
  | { type: 'float'; value: number }
  | { type: 'text'; value: string }
  | { type: 'blob'; base64: string }

interface HStmt {
  sql?: string
  sql_id?: number
  args?: HValue[]
  named_args?: { name: string; value: HValue }[]
  want_rows?: boolean
}

type HCond =
  | { type: 'ok' | 'error'; step: number }
  | { type: 'not'; cond: HCond }
  | { type: 'and' | 'or'; conds: HCond[] }
  | { type: 'is_autocommit' }

interface Stream {
  tx: Transaction | null
  sqls: Map<number, string>
}

const streams = new Map<string, Stream>()

function decodeValue(v: HValue): InValue {
  switch (v.type) {
    case 'null':
      return null
    case 'integer':
      return BigInt(v.value)
    case 'float':
      return v.value
    case 'text':
      return v.value
    case 'blob':
      return Buffer.from(v.base64, 'base64')
  }
}

function encodeValue(v: unknown): HValue {
  if (v === null || v === undefined) return { type: 'null' }
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v }
  }
  if (typeof v === 'string') return { type: 'text', value: v }
  if (v instanceof ArrayBuffer) return { type: 'blob', base64: Buffer.from(v).toString('base64') }
  if (ArrayBuffer.isView(v)) {
    return { type: 'blob', base64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') }
  }
  return { type: 'text', value: String(v) }
}

function encodeResult(rs: ResultSet) {
  return {
    cols: rs.columns.map((name, i) => ({ name, decltype: rs.columnTypes[i] || null })),
    rows: rs.rows.map((row) => rs.columns.map((_, i) => encodeValue(row[i]))),
    affected_row_count: rs.rowsAffected,
    last_insert_rowid: rs.lastInsertRowid !== undefined ? rs.lastInsertRowid.toString() : null,
    rows_read: 0,
    rows_written: 0,
    query_duration_ms: 0,
  }
}

const EMPTY: ResultSet = {
  columns: [],
  columnTypes: [],
  rows: [],
  rowsAffected: 0,
  lastInsertRowid: undefined,
  toJSON: () => ({}),
}

async function execStmt(stream: Stream, stmt: HStmt): Promise<ResultSet> {
  const sql = stmt.sql ?? (stmt.sql_id !== undefined ? stream.sqls.get(stmt.sql_id) : undefined)
  if (sql === undefined) throw new Error('SQL text not found')
  const head = sql.trim().toUpperCase()
  if (/^BEGIN\b/.test(head)) {
    if (stream.tx) throw new Error('cannot start a transaction within a transaction')
    const mode = /\bIMMEDIATE\b|\bEXCLUSIVE\b/.test(head) ? 'write' : 'deferred'
    stream.tx = await client.transaction(mode)
    return EMPTY
  }
  if (/^(COMMIT|END)\b/.test(head)) {
    if (!stream.tx) throw new Error('cannot commit - no transaction is active')
    const tx = stream.tx
    stream.tx = null
    await tx.commit()
    return EMPTY
  }
  if (/^ROLLBACK\b/.test(head)) {
    const tx = stream.tx
    stream.tx = null
    if (tx) await tx.rollback()
    return EMPTY
  }
  let args: InValue[] | Record<string, InValue> = (stmt.args ?? []).map(decodeValue)
  if (stmt.named_args && stmt.named_args.length) {
    const named: Record<string, InValue> = {}
    for (const a of stmt.named_args) named[a.name.replace(/^[:@$]/, '')] = decodeValue(a.value)
    args = named
  }
  const target = stream.tx ?? client
  return target.execute({ sql, args })
}

function evalCond(cond: HCond | undefined, ok: boolean[], err: boolean[], stream: Stream): boolean {
  if (!cond) return true
  switch (cond.type) {
    case 'ok':
      return ok[cond.step] === true
    case 'error':
      return err[cond.step] === true
    case 'not':
      return !evalCond(cond.cond, ok, err, stream)
    case 'and':
      return cond.conds.every((c) => evalCond(c, ok, err, stream))
    case 'or':
      return cond.conds.some((c) => evalCond(c, ok, err, stream))
    case 'is_autocommit':
      return stream.tx === null
  }
}

function errorBody(e: unknown) {
  const message = e instanceof Error ? e.message : String(e)
  const code = (e as { code?: string })?.code
  return { message, code: typeof code === 'string' ? code : 'SQLITE_ERROR' }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleRequest(stream: Stream, req: any): Promise<unknown> {
  switch (req.type) {
    case 'close':
      if (stream.tx) {
        await stream.tx.rollback().catch(() => {})
        stream.tx = null
      }
      return { type: 'close' }
    case 'execute':
      return { type: 'execute', result: encodeResult(await execStmt(stream, req.stmt)) }
    case 'batch': {
      const steps: { stmt: HStmt; condition?: HCond }[] = req.batch.steps
      const ok: boolean[] = []
      const err: boolean[] = []
      const stepResults: unknown[] = []
      const stepErrors: unknown[] = []
      for (let i = 0; i < steps.length; i++) {
        if (!evalCond(steps[i].condition, ok, err, stream)) {
          stepResults.push(null)
          stepErrors.push(null)
          continue
        }
        try {
          stepResults.push(encodeResult(await execStmt(stream, steps[i].stmt)))
          stepErrors.push(null)
          ok[i] = true
        } catch (e) {
          stepResults.push(null)
          stepErrors.push(errorBody(e))
          err[i] = true
        }
      }
      return { type: 'batch', result: { step_results: stepResults, step_errors: stepErrors } }
    }
    case 'sequence': {
      const sql = req.sql ?? stream.sqls.get(req.sql_id)
      if (stream.tx) await stream.tx.executeMultiple(sql)
      else await client.executeMultiple(sql)
      return { type: 'sequence' }
    }
    case 'store_sql':
      stream.sqls.set(req.sql_id, req.sql)
      return { type: 'store_sql' }
    case 'close_sql':
      stream.sqls.delete(req.sql_id)
      return { type: 'close_sql' }
    case 'get_autocommit':
      return { type: 'get_autocommit', is_autocommit: stream.tx === null }
    default:
      throw new Error(`Unsupported request type: ${req.type}`)
  }
}

// Requests are processed one at a time (SQLite has a single writer anyway).
let queue: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  try {
    if (req.method === 'GET' && (path === '/v2' || path === '/health')) return send(res, 200, {})
    if (req.method === 'GET' && path.startsWith('/v3')) return send(res, 404, { message: 'v3 not supported' })
    if (req.method === 'POST' && path === '/v2/pipeline') {
      const body = JSON.parse(await readBody(req))
      const out = await serialize(async () => {
        const baton: string = body.baton ?? randomBytes(12).toString('hex')
        const stream = streams.get(baton) ?? { tx: null, sqls: new Map() }
        const results: unknown[] = []
        let closed = false
        for (const r of body.requests ?? []) {
          try {
            results.push({ type: 'ok', response: await handleRequest(stream, r) })
          } catch (e) {
            results.push({ type: 'error', error: errorBody(e) })
          }
          if (r.type === 'close') closed = true
        }
        streams.delete(baton)
        let nextBaton: string | null = null
        if (!closed) {
          nextBaton = randomBytes(12).toString('hex')
          streams.set(nextBaton, stream)
        }
        return { baton: nextBaton, base_url: null, results }
      })
      return send(res, 200, out)
    }
    send(res, 404, { message: `Not found: ${req.method} ${path}` })
  } catch (e) {
    send(res, 500, { message: e instanceof Error ? e.message : String(e) })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`dev-db bridge: file:${file} served on http://127.0.0.1:${port} (Hrana v2)`)
})
