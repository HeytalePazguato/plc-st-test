/** Simulated time in nanoseconds; it only moves when the cycle engine (or a test) advances it. */
export class SimClock {
  private ns = 0n

  nowNs(): bigint {
    return this.ns
  }

  advance(ns: bigint): void {
    if (ns < 0n) throw new RangeError('SimClock.advance: negative duration')
    this.ns += ns
  }
}
