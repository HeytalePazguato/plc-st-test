/**
 * TIME literal parsing shared by the interpreter and by tooling that reads durations from configuration (the CLI's `cycle_time`).
 */

export const UNIT_NS: Record<string, bigint> = {
  d: 86_400_000_000_000n,
  h: 3_600_000_000_000n,
  m: 60_000_000_000n,
  s: 1_000_000_000n,
  ms: 1_000_000n,
  us: 1_000n,
  ns: 1n,
}

/** `amount` (digits with an optional `.fraction`) times `unit` nanoseconds, truncated to whole nanoseconds. */
export function scaled(amount: string, unit: bigint): bigint {
  const [whole, fraction = ''] = amount.split('.')
  const frac = fraction === '' ? 0n : (BigInt(fraction) * unit) / 10n ** BigInt(fraction.length)
  return BigInt(whole) * unit + frac
}

/** The text after `T#` as nanoseconds (`-1h2m3s4ms`, `1.5s`), or undefined when it is not a duration. */
export function parseDurationBody(text: string): bigint | undefined {
  let body = text
  const negative = body.startsWith('-')
  if (body.startsWith('-') || body.startsWith('+')) body = body.slice(1)
  let total = 0n
  let consumed = 0
  for (const m of body.matchAll(/(\d+(?:\.\d+)?)(ms|us|ns|d|h|m|s)/gi)) {
    total += scaled(m[1], UNIT_NS[m[2].toLowerCase()])
    consumed += m[0].length
  }
  if (consumed !== body.length || consumed === 0) return undefined
  return negative ? -total : total
}

/** Parses a full TIME literal (`T#10ms`, `TIME#-1s500ms`, `LTIME#2h`; prefix case-insensitive) into nanoseconds, or undefined when it is not one. */
export function parseTimeLiteral(text: string): bigint | undefined {
  const m = /^(?:T|TIME|LTIME)#(.*)$/i.exec(text.trim())
  return m === null ? undefined : parseDurationBody(m[1])
}
