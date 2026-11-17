export type PartnerMode = 'playfield' | 'video'

export type PartnerStats = {
  rtt: number
  /** Time from a frame leaving the host's screen to it showing on the partner's screen. */
  video: number | null
  mode: PartnerMode
}

/** Host browser to bridge to injected key press. */
export const INJECT_LAG_MS = 2
/** Allowance for tosu's own polling interval. */
export const SOURCE_LAG_MS = 4
const MAX_OFFSET = 300

/** How late a partner's input lands when they react to the streamed video. */
export function videoInputLag(stats: PartnerStats) {
  return (stats.video ?? stats.rtt / 2 + 40) + stats.rtt / 2 + INJECT_LAG_MS
}

/**
 * osu! stable: hitting late means the Universal Offset must go down (negative).
 * Rounded to 5 ms because the lag itself drifts by a few ms.
 */
export function compensatingOffset(lagMs: number, current: number | null) {
  const value = (current ?? 0) - Math.round(lagMs / 5) * 5
  return Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, value))
}

export function formatMs(value: number) {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(Math.round(value))} ms`
}
