export type Role = 'aim' | 'tap'
export type TapSlot = 'k1' | 'k2'

export type GuestMessage =
  | { t: 'key'; k: TapSlot; down: boolean; n: number }
  | { t: 'aim'; s: number; x: number; y: number }
  | { t: 'release' }
  | { t: 'video-retry' }
  | {
      t: 'ping'
      ts: number
      rtt?: number
      video?: number | null
      mode?: 'playfield' | 'video'
      vs?: VideoIssue | 'ok'
    }

/** Why the partner sees no picture. */
export type VideoIssue = 'connecting' | 'network' | 'host-capture' | 'decode'

export type HostMessage =
  | { t: 'welcome'; guestRole: Role }
  | { t: 'pong'; ts: number }
  | { t: 'host-video'; frames: number; live: boolean }
  | { t: 'full' }
  | { t: 'input-ok' }
  /** `map` is the checksum of the map osu! is on; older hosts leave it out. */
  | { t: 'sync'; live: boolean; mods: number; map?: string | null }
  | { t: 'map'; id: string; i: number; n: number; d: string }
  | { t: 'skin'; id: string; i: number; n: number; d: string }

export const MAP_CHUNK_CHARS = 16_000

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

/**
 * A pre-negotiated, unordered, zero-retransmit channel on the same peer connection as the
 * control channel. PeerJS's `reliable: false` only disables ordering and still retransmits,
 * which makes stale cursor packets queue up behind lost ones.
 */
export function openInputChannel(pc: RTCPeerConnection | undefined) {
  if (!pc) return null
  try {
    const channel = pc.createDataChannel('input', { negotiated: true, id: 1000, ordered: false, maxRetransmits: 0 })
    channel.binaryType = 'arraybuffer'
    return channel
  } catch {
    return null
  }
}

const PACKET_AIM = 1
const PACKET_KEY = 2

export function encodeAim(seq: number, x: number, y: number) {
  const view = new DataView(new ArrayBuffer(9))
  view.setUint8(0, PACKET_AIM)
  view.setUint32(1, seq)
  view.setUint16(5, Math.round(x * 65535))
  view.setUint16(7, Math.round(y * 65535))
  return view.buffer
}

export function encodeKey(seq: number, slot: TapSlot, down: boolean) {
  const view = new DataView(new ArrayBuffer(7))
  view.setUint8(0, PACKET_KEY)
  view.setUint32(1, seq)
  view.setUint8(5, slot === 'k1' ? 1 : 2)
  view.setUint8(6, down ? 1 : 0)
  return view.buffer
}

const PACKET_CLOCK = 3

export function encodeClock(seq: number, time: number, rate: number, playing: boolean) {
  const view = new DataView(new ArrayBuffer(18))
  view.setUint8(0, PACKET_CLOCK)
  view.setUint32(1, seq)
  view.setFloat64(5, time)
  view.setFloat32(13, rate)
  view.setUint8(17, playing ? 1 : 0)
  return view.buffer
}

const PACKET_PROBE = 4

export function encodeProbe() {
  const view = new DataView(new ArrayBuffer(7))
  view.setUint8(0, PACKET_PROBE)
  return view.buffer
}

export type InputPacket =
  | { t: 'aim'; s: number; x: number; y: number }
  | { t: 'key'; n: number; k: TapSlot; down: boolean }
  | { t: 'clock'; s: number; time: number; rate: number; playing: boolean }
  | { t: 'probe' }

export function decodeInput(data: unknown): InputPacket | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 7) return null
  const view = new DataView(data)
  const type = view.getUint8(0)
  if (type === PACKET_CLOCK && data.byteLength >= 18) {
    return {
      t: 'clock',
      s: view.getUint32(1),
      time: view.getFloat64(5),
      rate: view.getFloat32(13),
      playing: view.getUint8(17) === 1,
    }
  }
  if (type === PACKET_PROBE) return { t: 'probe' }
  if (type === PACKET_AIM && data.byteLength >= 9) {
    return { t: 'aim', s: view.getUint32(1), x: view.getUint16(5) / 65535, y: view.getUint16(7) / 65535 }
  }
  if (type === PACKET_KEY) {
    const slot = view.getUint8(5)
    if (slot !== 1 && slot !== 2) return null
    return { t: 'key', n: view.getUint32(1), k: slot === 1 ? 'k1' : 'k2', down: view.getUint8(6) === 1 }
  }
  return null
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
    const encoding = params.encodings[0] as RTCRtpEncodingParameters & {
      priority?: string
      networkPriority?: string
    }
    encoding.maxBitrate = 8_000_000
    encoding.maxFramerate = 60
    encoding.priority = 'high'
    encoding.networkPriority = 'high'
    // Each frame encodes, sends and decodes noticeably faster at 720p than at 1080p+, and the
    // circles stay easy to read.
    const height = sender.track.getSettings().height ?? 0
    encoding.scaleResolutionDownBy = height > 720 ? height / 720 : 1
    ;(params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
      'maintain-framerate'
    try {
      await sender.setParameters(params)
    } catch {}
  }
}
