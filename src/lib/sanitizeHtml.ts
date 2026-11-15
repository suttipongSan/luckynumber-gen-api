// Allowlist HTML sanitizer for the long text of a landing article (landing_items.content_html).
//
// Dependency free and DOM free on purpose: it has to run in the Workers runtime (no DOMParser,
// and HTMLRewriter is not available in the Node tests) and in vitest alike. It is NOT a
// regex-replace over the document. A small tokenizer follows the HTML tokenization rules for the
// states that matter (tags, attributes, comments, doctype / CDATA / processing instructions, raw
// text elements), and the output is REBUILT from an allowlist, so nothing the input says can slip
// through unchanged:
//
//   - tags: p br strong b em i u h2 h3 ul ol li blockquote a. Any other tag is removed and its text
//     is kept, EXCEPT the DROP_CONTENT_TAGS below, whose whole content goes with them.
//   - attributes: only `href` of an <a>. It must be an absolute http://, https:// or mailto: URL
//     (after the entity decoding and whitespace handling a browser would apply), otherwise the <a>
//     is unwrapped and its text kept. Every kept <a> gets rel="noopener noreferrer nofollow" and
//     target="_blank" from here, whatever the input said. All other attributes are dropped.
//   - comments, CDATA, doctype and processing instructions are dropped.
//   - the output is well formed: tags are balanced (an unclosed one is closed at the end, a stray
//     end tag is dropped, a few HTML implied end tags are applied: a block closes an open <p>, an
//     <li> closes an <li>, a heading closes a heading, an <a> closes an <a>), text and attribute
//     values are entity escaped (& < > ").
//   - null bytes and the other control characters are removed, lone surrogates become U+FFFD.
//   - idempotent: sanitizeHtml(sanitizeHtml(x)) === sanitizeHtml(x). Output text is canonical (a
//     character reference is kept or normalized, never decoded twice) and the tag rules only look
//     at the element on top of the stack, so re-reading the output rebuilds the same tree.
//   - linear time: every scan moves forward over the input once, end tags are matched with
//     per-name counters and every popped element was pushed once. No regex works on the document
//     as a replace: the only patterns are a one-character class test (control characters), a test
//     of the first few characters of a URL, and the forward search for `</script`, `</style` ...
//     which has nothing to backtrack over.
//
// Because the output is generated and not copied, the correctness of the tokenizer is not what the
// safety rests on: a tokenizer that disagrees with a browser can only change WHICH text survives,
// never let markup through. The web app runs its own allowlist sanitizer with the same rules
// before it renders (defence in depth).

/** Tags that survive sanitizing. */
export const ALLOWED_TAGS: readonly string[] = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'h2',
  'h3',
  'ul',
  'ol',
  'li',
  'blockquote',
  'a',
]

/** Tags removed together with everything inside them (any other disallowed tag keeps its text). */
export const DROP_CONTENT_TAGS: readonly string[] = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
  'noscript',
  'title',
  'textarea',
  'select',
  'option',
  'form',
  'input',
  'button',
  'link',
  'meta',
  'base',
  'head',
  'img',
  'video',
  'audio',
  'source',
  'picture',
  'canvas',
]

const ALLOWED = new Set(ALLOWED_TAGS)

/** Dropped elements whose content is raw text / RCDATA: it ends at the first matching end tag. */
const RAW_DROP = ['script', 'style', 'iframe', 'noscript', 'textarea', 'title']
/** Dropped void elements: there is no content, only the tag itself goes. */
const VOID_DROP = new Set(['img', 'input', 'link', 'meta', 'base', 'source', 'embed'])
/** Dropped elements whose content is markup: it ends at the matching (nested) end tag. */
const MARKUP_DROP = new Set([
  'object',
  'svg',
  'math',
  'template',
  'select',
  'option',
  'form',
  'button',
  'head',
  'video',
  'audio',
  'picture',
  'canvas',
])

/**
 * `</name` followed by whitespace, `/` or `>`: the end of a raw text element. One sticky-free
 * global pattern per element; `lastIndex` is always set before use.
 */
const RAW_END = new Map<string, RegExp>(
  RAW_DROP.map((name): [string, RegExp] => [name, new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi')]),
)

/** Start tags that implicitly close an open <p> (HTML does the same). */
const CLOSES_P = new Set(['p', 'h2', 'h3', 'ul', 'ol', 'blockquote', 'li'])

// ---- characters

const isAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
const isDigit = (c: number) => c >= 0x30 && c <= 0x39
const isAlnum = (c: number) => isAlpha(c) || isDigit(c)
/** HTML whitespace: tab, line feed, form feed, carriage return, space. */
const isWs = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d

/** Lower-cases A-Z only (HTML tag and attribute names; String#toLowerCase would also fold Kelvin etc.). */
function lowerAscii(s: string): string {
  let out = ''
  let last = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0x41 && c <= 0x5a) {
      out += s.slice(last, i) + String.fromCharCode(c + 32)
      last = i + 1
    }
  }
  return last === 0 ? s : out + s.slice(last)
}

function trimWs(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && isWs(s.charCodeAt(a))) a++
  while (b > a && isWs(s.charCodeAt(b - 1))) b--
  return a === 0 && b === s.length ? s : s.slice(a, b)
}

const NEEDS_CLEAN = /[\u0000-\u0008\u000b\u000e-\u001f\u007f\ud800-\udfff]/

/**
 * Removes NUL and the other control characters (everything below U+0020 except tab, LF, FF and
 * CR, plus DEL) and replaces unpaired surrogates with U+FFFD. Removing them BEFORE tokenizing only
 * ever makes the input look more like a tag, never less ("<scr\0ipt>" is dropped as <script>).
 */
function cleanInput(s: string): string {
  if (!NEEDS_CLEAN.test(s)) return s
  let out = ''
  let last = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 ? c !== 0x09 && c !== 0x0a && c !== 0x0c && c !== 0x0d : c === 0x7f) {
      out += s.slice(last, i)
      last = i + 1
    } else if (c >= 0xd800 && c <= 0xdfff) {
      if (c <= 0xdbff) {
        const d = s.charCodeAt(i + 1)
        if (d >= 0xdc00 && d <= 0xdfff) {
          i++ // a valid pair stays as it is
          continue
        }
      }
      out += s.slice(last, i) + '�'
      last = i + 1
    }
  }
  return out + s.slice(last)
}

// ---- character references and escaping

/** Named references decoded in text and in attribute values (anything else is left alone). */
const NAMED_REFS = new Map<string, string>([
  ['amp', '&'],
  ['AMP', '&'],
  ['lt', '<'],
  ['LT', '<'],
  ['gt', '>'],
  ['GT', '>'],
  ['quot', '"'],
  ['QUOT', '"'],
  ['apos', "'"],
  ['nbsp', '\u00a0'],
])
/** Extra names decoded in an href only, so "java&Tab;script&colon;" is seen as what a browser sees. */
const URL_NAMED_REFS = new Map<string, string>([
  ['Tab', '\t'],
  ['NewLine', '\n'],
  ['colon', ':'],
])

/** Text for a numeric reference: U+FFFD for the impossible ones, nothing for control characters. */
function codePointText(cp: number): string {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�'
  if (cp < 0x20 ? cp !== 0x09 && cp !== 0x0a && cp !== 0x0c && cp !== 0x0d : cp === 0x7f) return ''
  return String.fromCodePoint(cp)
}

interface CharRef {
  /** Index just after the reference. */
  end: number
  /** The decoded text, or null to keep the source text of the reference as it is. */
  value: string | null
}

/**
 * Reads the character reference that starts at the `&` at `i`, or null when there is none (the
 * `&` is then an ordinary character). Numeric references (`&#106;`, `&#x6A;`, the `;` may be
 * missing like in browsers) and the names in NAMED_REFS are decoded. In text any other well formed
 * `&name;` is kept verbatim (a browser shows the character, we never have to know the whole
 * table); in an attribute it is not a reference (the `&` is escaped), so the value a browser sees
 * is exactly the one that was checked.
 */
function readRef(s: string, i: number, inAttr: boolean): CharRef | null {
  const n = s.length
  if (s.charCodeAt(i + 1) === 0x23) {
    let j = i + 2
    let base = 10
    const x = s.charCodeAt(j)
    if (x === 0x78 || x === 0x58) {
      base = 16
      j++
    }
    const digitsStart = j
    let cp = 0
    for (; j < n; j++) {
      const c = s.charCodeAt(j)
      let d: number
      if (isDigit(c)) d = c - 0x30
      else if (base === 16 && c >= 0x61 && c <= 0x66) d = c - 0x57
      else if (base === 16 && c >= 0x41 && c <= 0x46) d = c - 0x37
      else break
      cp = Math.min(cp * base + d, 0x110000)
    }
    if (j === digitsStart) return null
    if (s.charCodeAt(j) === 0x3b) j++
    return { end: j, value: codePointText(cp) }
  }
  if (!isAlpha(s.charCodeAt(i + 1))) return null
  let j = i + 2
  while (j < n && j - i <= 32 && isAlnum(s.charCodeAt(j))) j++
  if (s.charCodeAt(j) !== 0x3b) return null
  const name = s.slice(i + 1, j)
  const decoded = NAMED_REFS.get(name) ?? (inAttr ? URL_NAMED_REFS.get(name) : undefined)
  if (decoded !== undefined) return { end: j + 1, value: decoded }
  return inAttr ? null : { end: j + 1, value: null }
}

/**
 * Escapes & < > " of an already decoded string. A no-break space stays the raw character (`&nbsp;`
 * in the input is decoded to it): it is one character, like in the web app's serializer, so the
 * length the editor counts is the length that is stored.
 */
function escapeLiteral(v: string): string {
  let out = ''
  let last = 0
  for (let i = 0; i < v.length; i++) {
    const rep = escapeChar(v.charCodeAt(i))
    if (rep !== null) {
      out += v.slice(last, i) + rep
      last = i + 1
    }
  }
  return last === 0 ? v : out + v.slice(last)
}

function escapeChar(c: number): string | null {
  switch (c) {
    case 0x26:
      return '&amp;'
    case 0x3c:
      return '&lt;'
    case 0x3e:
      return '&gt;'
    case 0x22:
      return '&quot;'
    default:
      return null
  }
}

/** Text content as it appears in the source (references still encoded) -> canonical escaped text. */
function escapeText(raw: string): string {
  let out = ''
  let last = 0
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    let rep: string | null
    let next = i + 1
    if (c === 0x26) {
      const ref = readRef(raw, i, false)
      if (!ref) {
        rep = '&amp;'
      } else {
        rep = ref.value === null ? raw.slice(i, ref.end) : escapeLiteral(ref.value)
        next = ref.end
      }
    } else {
      rep = escapeChar(c)
      if (rep === null) continue
    }
    out += raw.slice(last, i) + rep
    last = next
    i = next - 1
  }
  return last === 0 ? raw : out + raw.slice(last)
}

/** Decodes the character references of an attribute value (see {@link readRef}). */
function decodeAttribute(raw: string): string {
  let out = ''
  let last = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) !== 0x26) continue
    const ref = readRef(raw, i, true)
    if (!ref) continue
    out += raw.slice(last, i) + (ref.value ?? '')
    last = ref.end
    i = ref.end - 1
  }
  return last === 0 ? raw : out + raw.slice(last)
}

// ---- links

/** An absolute http(s) URL with a host, or a mailto: address. Only the start is looked at. */
const SAFE_URL = /^(?:https?:\/\/[^/?#\s]|mailto:\S)/i

/**
 * The URL to keep for an href value, or null when the link has to be unwrapped. The value is
 * judged the way a browser reads it: character references are decoded, tab / CR / LF anywhere are
 * ignored, control characters and spaces around it are stripped. The RESULT of that is what is
 * checked and what is written out (escaped), so "jav&#x09;ascript:", "&#106;avascript:" and
 * " javascript:" all end up as plain javascript: and are refused: only http://, https:// and
 * mailto: pass.
 */
export function sanitizeHref(raw: string): string | null {
  let v = decodeAttribute(raw)
  let out = ''
  let last = 0
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c === 0x09 || c === 0x0a || c === 0x0d) {
      out += v.slice(last, i)
      last = i + 1
    } else if (c < 0x20 && c !== 0x0c) {
      return null
    }
  }
  if (last !== 0) v = out + v.slice(last)
  let a = 0
  let b = v.length
  while (a < b && v.charCodeAt(a) <= 0x20) a++
  while (b > a && v.charCodeAt(b - 1) <= 0x20) b--
  v = v.slice(a, b)
  for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) < 0x20) return null
  return SAFE_URL.test(v) ? v : null
}

// ---- tokenizer

interface Tag {
  /** Lower-cased tag name. */
  name: string
  /** Index just after the closing `>`. */
  end: number
  selfClosing: boolean
  /** Raw value of the first href attribute of an <a> start tag, null when there is none. */
  href: string | null
}

/**
 * Reads the start tag (`<` at `start`, a letter after it) or end tag (`</` at `start`, a letter
 * after it) with all its attributes, following the HTML tokenizer: names end at whitespace, `/`
 * and `>`; a quoted value ends at the matching quote, an unquoted one at whitespace or `>`; the
 * first of a duplicate attribute wins. Null when the input ends inside the tag (a browser drops
 * such a tag as well, and nothing after it can be markup).
 */
function readTag(s: string, start: number, isEnd: boolean): Tag | null {
  const n = s.length
  let i = start + (isEnd ? 2 : 1)
  const nameStart = i
  while (i < n) {
    const c = s.charCodeAt(i)
    if (isWs(c) || c === 0x2f || c === 0x3e) break
    i++
  }
  if (i >= n) return null
  const name = lowerAscii(s.slice(nameStart, i))
  const wantHref = !isEnd && name === 'a'
  let href: string | null = null
  let selfClosing = false
  for (;;) {
    while (i < n && isWs(s.charCodeAt(i))) i++
    if (i >= n) return null
    const c = s.charCodeAt(i)
    if (c === 0x3e) {
      i++
      break
    }
    if (c === 0x2f) {
      i++
      if (i >= n) return null
      if (s.charCodeAt(i) === 0x3e) {
        selfClosing = true
        i++
        break
      }
      continue
    }
    // An attribute name. Its first character is part of it whatever it is (a leading "=" too).
    const attrStart = i
    i++
    while (i < n) {
      const d = s.charCodeAt(i)
      if (isWs(d) || d === 0x2f || d === 0x3e || d === 0x3d) break
      i++
    }
    const attrName = s.slice(attrStart, i)
    while (i < n && isWs(s.charCodeAt(i))) i++
    if (i >= n) return null
    let value = ''
    if (s.charCodeAt(i) === 0x3d) {
      i++
      while (i < n && isWs(s.charCodeAt(i))) i++
      if (i >= n) return null
      const q = s.charCodeAt(i)
      if (q === 0x22 || q === 0x27) {
        const close = s.indexOf(q === 0x22 ? '"' : "'", i + 1)
        if (close === -1) return null
        value = s.slice(i + 1, close)
        i = close + 1
      } else if (q !== 0x3e) {
        const valueStart = i
        while (i < n) {
          const d = s.charCodeAt(i)
          if (isWs(d) || d === 0x3e) break
          i++
        }
        value = s.slice(valueStart, i)
      }
    }
    if (wantHref && href === null && lowerAscii(attrName) === 'href') href = value
  }
  return { name, end: i, selfClosing, href }
}

/**
 * Index of the next `<` that starts markup: a letter (tag), `/` (end tag or bogus comment, but not
 * a lone `</` at the very end), `!` (comment, doctype, CDATA) or `?` (processing instruction).
 * Any other `<` is plain text. -1 when there is none.
 */
function findMarkup(s: string, from: number): number {
  let i = from
  for (;;) {
    i = s.indexOf('<', i)
    if (i === -1) return -1
    const c = s.charCodeAt(i + 1)
    if (isAlpha(c) || c === 0x21 || c === 0x3f || (c === 0x2f && i + 2 < s.length)) return i
    i++
  }
}

/** Index just after the comment that starts at `start` (`<!--`); the length when it never ends. */
function commentEnd(s: string, start: number): number {
  let i = start + 4
  if (s.charCodeAt(i) === 0x3e) return i + 1 // <!-->
  if (s.charCodeAt(i) === 0x2d && s.charCodeAt(i + 1) === 0x3e) return i + 2 // <!--->
  for (;;) {
    const p = s.indexOf('--', i)
    if (p === -1) return s.length
    const c = s.charCodeAt(p + 2)
    if (c === 0x3e) return p + 3 // -->
    if (c === 0x21 && s.charCodeAt(p + 3) === 0x3e) return p + 4 // --!>
    i = p + 1
  }
}

/** Index just after the next `needle` at or after `from`; the length when there is none. */
function skipPast(s: string, needle: string, from: number): number {
  const p = s.indexOf(needle, from)
  return p === -1 ? s.length : p + needle.length
}

// ---- sanitizer

/**
 * Sanitizes `input` (an HTML fragment of any size) and returns the safe HTML described at the top
 * of this file. Never throws on a string. Leading and trailing whitespace of the result is removed,
 * so a text without any visible content comes out as ''.
 */
export function sanitizeHtml(input: string): string {
  if (typeof input !== 'string' || input === '') return ''
  const s = cleanInput(input)
  const n = s.length
  const out: string[] = []
  /** Open allowed elements, innermost last. */
  const stack: string[] = []
  /** How many elements of each name are open (so a stray end tag costs O(1)). */
  const open: Record<string, number> = Object.create(null)
  /** While set, we are inside a dropped element with markup content: nothing is written. */
  let dropName: string | null = null
  let dropDepth = 0
  let pos = 0

  const popOne = () => {
    const name = stack.pop() as string
    open[name]--
    out.push(`</${name}>`)
  }
  /** Closes elements down to and including the innermost open `name` (which must be open). */
  const closeTo = (name: string) => {
    for (;;) {
      const top = stack[stack.length - 1]
      popOne()
      if (top === name) return
    }
  }

  const openElement = (tag: Tag) => {
    const name = tag.name
    if (name === 'a') {
      const url = tag.href === null ? null : sanitizeHref(tag.href)
      if (url === null) return // unwrapped: the tag goes, its text stays
      if (open.a) closeTo('a') // a link cannot contain a link
      stack.push('a')
      open.a = (open.a || 0) + 1
      out.push(`<a href="${escapeLiteral(url)}" rel="noopener noreferrer nofollow" target="_blank">`)
      return
    }
    if (CLOSES_P.has(name) && stack[stack.length - 1] === 'p') popOne()
    if (name === 'li' && stack[stack.length - 1] === 'li') popOne()
    if ((name === 'h2' || name === 'h3') && (stack[stack.length - 1] === 'h2' || stack[stack.length - 1] === 'h3')) {
      popOne()
    }
    if (name === 'br') {
      out.push('<br>')
      return
    }
    stack.push(name)
    open[name] = (open[name] || 0) + 1
    out.push(`<${name}>`)
  }

  const onStart = (tag: Tag) => {
    const name = tag.name
    if (dropName !== null) {
      if (name === dropName) {
        if (!(tag.selfClosing && (name === 'svg' || name === 'math'))) dropDepth++
      } else if (dropName === 'head' && name === 'body') {
        dropName = null // a head that was never closed ends where the body starts
      }
      return
    }
    if (ALLOWED.has(name)) {
      openElement(tag)
      return
    }
    const rawEnd = RAW_END.get(name)
    if (rawEnd) {
      // script, style ...: everything up to the first matching end tag is text of the element.
      rawEnd.lastIndex = pos
      const m = rawEnd.exec(s)
      const endTag = m ? readTag(s, m.index, true) : null
      pos = endTag ? endTag.end : n
      return
    }
    if (MARKUP_DROP.has(name)) {
      if ((name === 'svg' || name === 'math') && tag.selfClosing) return
      dropName = name
      dropDepth = 1
    }
    // VOID_DROP and every other tag: only the tag is removed.
  }

  const onEnd = (name: string) => {
    if (dropName !== null) {
      if (name === dropName && --dropDepth === 0) dropName = null
      return
    }
    if (name !== 'br' && open[name]) closeTo(name)
  }

  while (pos < n) {
    const lt = findMarkup(s, pos)
    const stop = lt === -1 ? n : lt
    if (stop > pos && dropName === null) out.push(escapeText(s.slice(pos, stop)))
    if (lt === -1) break
    pos = lt
    const c1 = s.charCodeAt(lt + 1)
    if (isAlpha(c1)) {
      const tag = readTag(s, lt, false)
      if (!tag) break
      pos = tag.end
      onStart(tag)
    } else if (c1 === 0x2f) {
      const c2 = s.charCodeAt(lt + 2)
      if (isAlpha(c2)) {
        const tag = readTag(s, lt, true)
        if (!tag) break
        pos = tag.end
        onEnd(tag.name)
      } else if (c2 === 0x3e) {
        pos = lt + 3 // "</>" is ignored
      } else {
        pos = skipPast(s, '>', lt + 2) // a bogus comment
      }
    } else if (c1 === 0x21) {
      if (s.startsWith('<!--', lt)) pos = commentEnd(s, lt)
      else if (s.startsWith('<![CDATA[', lt)) pos = skipPast(s, ']]>', lt + 9)
      else pos = skipPast(s, '>', lt + 2) // doctype or a bogus comment
    } else {
      pos = skipPast(s, '>', lt + 2) // <?...> processing instruction (a bogus comment)
    }
  }
  while (stack.length > 0) popOne()
  return trimWs(out.join(''))
}
