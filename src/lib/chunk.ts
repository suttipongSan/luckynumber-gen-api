// Cloudflare D1 allows at most 100 bound parameters per statement. Long `IN (...)` lists and
// multi-row inserts are split with these helpers.

/** Max values in one `inArray(...)` list, leaving room for a few other parameters. */
export const IN_CHUNK = 90

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
