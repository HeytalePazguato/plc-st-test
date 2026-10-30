/**
 * Human-readable rendering of runtime values for assertion messages and reports.
 */
import type { IecValue, TypeResolver } from './interpreter/values.js'

const NS = { d: 86_400_000_000_000n, h: 3_600_000_000_000n, m: 60_000_000_000n, s: 1_000_000_000n, ms: 1_000_000n, us: 1_000n, ns: 1n } as const

/** TIME from nanoseconds: `T#1s500ms`, `T#-2m`, `T#0s`. */
export function formatTime(ns: bigint): string {
  if (ns === 0n) return 'T#0s'
  const neg = ns < 0n
  let rest = neg ? -ns : ns
  let out = ''
  for (const [unit, size] of Object.entries(NS)) {
    const n = rest / size
    if (n > 0n) out += `${String(n)}${unit}`
    rest -= n * size
  }
  return `T#${neg ? '-' : ''}${out}`
}

/** Shortest decimal text that parses back to the same number (as a REAL when `single`), with `.0` appended to integral values. */
export function formatReal(n: number, single = false): string {
  if (Number.isNaN(n)) return 'NaN'
  if (!Number.isFinite(n)) return n > 0 ? 'INF' : '-INF'
  let s = String(n)
  if (single) {
    for (let p = 1; p <= 9; p++) {
      const c = n.toPrecision(p)
      if (Math.fround(Number(c)) === n) {
        s = String(Number(c))
        break
      }
    }
  }
  return /^-?\d+$/.test(s) ? `${s}.0` : s
}

function quote(s: string, q: string): string {
  return q + [...s].map((c) => (c === '$' || c === q ? `$${c}` : c)).join('') + q
}

/** Compact display form of any value. `resolver` supplies enum member names (`E_X.NAME (3)`); without it an enum prints as `E_X(3)`. */
export function formatValue(v: IecValue, resolver?: TypeResolver): string {
  switch (v.kind) {
    case 'scalar':
      switch (v.type) {
        case 'BOOL':
          return v.value ? 'TRUE' : 'FALSE'
        case 'REAL':
          return formatReal(Number(v.value), true)
        case 'LREAL':
          return formatReal(Number(v.value))
        case 'STRING':
          return quote(String(v.value), "'")
        case 'WSTRING':
          return quote(String(v.value), '"')
        case 'TIME':
          return formatTime(BigInt(v.value as number | bigint))
        default:
          return String(v.value)
      }
    case 'enum': {
      const r = resolver?.resolveType(v.typeName)
      const name = r?.kind === 'enum' ? r.members.find((m) => m.value === v.value)?.name : undefined
      return name === undefined ? `${v.typeName}(${String(v.value)})` : `${v.typeName}.${name} (${String(v.value)})`
    }
    case 'array': {
      const walk = (dim: number, offset: number): { text: string; size: number } => {
        const [lo, hi] = v.dims[dim]
        const count = hi - lo + 1
        if (dim === v.dims.length - 1) return { text: `[${v.data.slice(offset, offset + count).map((e) => formatValue(e, resolver)).join(', ')}]`, size: count }
        const parts: string[] = []
        let used = 0
        for (let i = 0; i < count; i++) {
          const sub = walk(dim + 1, offset + used)
          parts.push(sub.text)
          used += sub.size
        }
        return { text: `[${parts.join(', ')}]`, size: used }
      }
      return v.dims.length === 0 ? '[]' : walk(0, 0).text
    }
    case 'struct':
      return `{${[...v.fields].map(([k, f]) => `${k} := ${formatValue(f, resolver)}`).join(', ')}}`
  }
}
