export type Role = 'aim' | 'tap'
export type TapSlot = 'k1' | 'k2'

export type GuestMessage =
  | { t: 'aim'; x: number; y: number; s: number }
  | { t: 'key'; k: TapSlot; down: boolean }
  | { t: 'release' }
  | { t: 'ping'; ts: number; rtt?: number }

export type HostMessage =
  | { t: 'welcome'; guestRole: Role }
  | { t: 'pong'; ts: number }
  | { t: 'full' }

export const ROOM_PREFIX = 'osu-coop-v1-'
export const DEFAULT_BRIDGE_PORT = 7273

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function makeRoomCode(length = 6) {
  const values = crypto.getRandomValues(new Uint32Array(length))
  return Array.from(values, (v) => CODE_ALPHABET[v % CODE_ALPHABET.length]).join('')
}

export function normalizeRoomCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
}

export const ROLE_LABEL: Record<Role, string> = {
  aim: 'Aimer',
  tap: 'Tapper',
}

export function otherRole(role: Role): Role {
  return role === 'aim' ? 'tap' : 'aim'
}

export function formatKey(key: string) {
  if (key === ' ') return 'Space'
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)
}

/** Lowers receive-side buffering so the stream trades smoothness for latency. */
export function minimizePlayoutDelay(pc: RTCPeerConnection | undefined) {
  if (!pc) return
  for (const receiver of pc.getReceivers()) {
    const r = receiver as RTCRtpReceiver & { playoutDelayHint?: number; jitterBufferTarget?: number }
    try {
      if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0
      if ('playoutDelayHint' in r) r.playoutDelayHint = 0
    } catch {}
  }
}

export async function tuneScreenSenders(pc: RTCPeerConnection | undefined) {
  if (!pc) return
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue
    const params = sender.getParameters()
    if (!params.encodings?.length) continue
    params.encodings[0].maxBitrate = 10_000_000
    params.encodings[0].maxFramerate = 60
    ;(params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
      'maintain-framerate'
    try {
      await sender.setParameters(params)
    } catch {}
  }
}
