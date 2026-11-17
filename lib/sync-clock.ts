// Jumps larger than this are seeks, retries or pauses rather than network jitter.
const SNAP_THRESHOLD_MS = 50
const SMOOTHING = 0.1

/**
 * Tracks the host's osu! song position on the partner's machine. Samples arrive late and
 * jittery, so the clock free-runs between them and is gently pulled toward each new sample.
 */
export class SyncClock {
  ready = false
  rate = 1
  playing = false
  private base = 0
  private anchor = 0
  private lastSeq = 0

  sample(seq: number, time: number, rate: number, playing: boolean, transitMs: number, now: number) {
    if (seq <= this.lastSeq) return
    this.lastSeq = seq
    const target = time + (playing ? rate * transitMs : 0)
    const predicted = this.at(now)
    const error = target - predicted
    const discontinuity =
      !this.ready || playing !== this.playing || rate !== this.rate || Math.abs(error) > SNAP_THRESHOLD_MS
    this.base = discontinuity ? target : predicted + error * SMOOTHING
    this.anchor = now
    this.rate = rate
    this.playing = playing
    this.ready = true
  }

  at(now: number) {
    return this.base + (this.playing ? this.rate * (now - this.anchor) : 0)
  }
}
