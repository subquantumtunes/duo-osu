import { type DataConnection, type MediaConnection, Peer } from 'peerjs'
import { ICE_SERVERS } from '@/lib/browser'
import {
  type GuestMessage,
  type HostMessage,
  MAP_CHUNK_CHARS,
  ROOM_PREFIX,
  type Role,
  type TapSlot,
  decodeInput,
  encodeClock,
  makeRoomCode,
  openInputChannel,
} from '@/lib/protocol'
import type { PartnerStats } from '@/lib/timing'

export type HostStatus = 'idle' | 'starting' | 'waiting' | 'connected' | 'error'

export type Quality = { fps: 60 | 120; height: 720 | 1080; codec: 'h264' | 'auto' }

export type EncoderStats = {
  fps: number | null
  height: number | null
  encodeMs: number | null
  name: string | null
  hardware: boolean | null
  limitation: string | null
}

type Handlers = {
  onAim(x: number, y: number): void
  onKey(slot: TapSlot, down: boolean): void
  onRelease(): void
  onChange(): void
}

const VIDEO_STATES = ['ok', 'connecting', 'network', 'host-capture', 'decode'] as const
const RETRY_COOLDOWN_MS = 3000
const STATS_INTERVAL_MS = 1000

const SHARE_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

/**
 * Moves one codec to the front of the offered video codecs. The guest answers with the first
 * codec it also supports, so this picks the encoder without touching the guest app.
 */
export function preferCodec(sdp: string, codec: string) {
  const lines = sdp.split('\r\n')
  const start = lines.findIndex((l) => l.startsWith('m=video'))
  if (start < 0) return sdp
  const next = lines.findIndex((l, i) => i > start && l.startsWith('m='))
  const section = lines.slice(start, next < 0 ? undefined : next)

  const fmtp = new Map<string, string>()
  for (const line of section) {
    const match = /^a=fmtp:(\d+) (.*)$/.exec(line)
    if (match) fmtp.set(match[1], match[2])
  }
  // Constrained baseline with packetization mode 1 is the profile hardware encoders support best.
  const score = (pt: string) => {
    const params = fmtp.get(pt) ?? ''
    return (params.includes('packetization-mode=1') ? 2 : 0) + (params.includes('profile-level-id=42e0') ? 1 : 0)
  }
  const wanted = section
    .map((l) => /^a=rtpmap:(\d+) ([^/]+)\//.exec(l))
    .filter((m): m is RegExpExecArray => m !== null && m[2].toUpperCase() === codec)
    .map((m) => m[1])
    .sort((a, b) => score(b) - score(a))
  if (wanted.length === 0) return sdp
  const rtx = [...fmtp].filter(([, params]) => wanted.some((pt) => params === `apt=${pt}`)).map(([pt]) => pt)
  const first = [...wanted, ...rtx]

  const parts = lines[start].split(' ')
  const payloads = parts.slice(3)
  lines[start] = [
    ...parts.slice(0, 3),
    ...first.filter((pt) => payloads.includes(pt)),
    ...payloads.filter((pt) => !first.includes(pt)),
  ].join(' ')
  return lines.join('\r\n')
}

async function tuneVideoSenders(pc: RTCPeerConnection, quality: Quality) {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue
    const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string }
    if (!params.encodings?.length) continue
    const encoding = params.encodings[0] as RTCRtpEncodingParameters & { priority?: string; networkPriority?: string }
    const base = quality.height >= 1080 ? 14_000_000 : 8_000_000
    encoding.maxBitrate = quality.fps > 60 ? base * 1.5 : base
    encoding.maxFramerate = quality.fps
    encoding.priority = 'high'
    encoding.networkPriority = 'high'
    const height = sender.track.getSettings().height ?? 0
    encoding.scaleResolutionDownBy = height > quality.height ? height / quality.height : 1
    params.degradationPreference = 'maintain-framerate'
    try {
      await sender.setParameters(params)
    } catch {}
  }
}

function describeShareError(err: unknown) {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError') {
    return 'Screen capture was blocked. Pick a screen in step 1, and on macOS allow screen recording for this app in System Settings.'
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'Couldn’t start capturing that screen. Close other apps that record the screen, then try again.'
  }
  return `Screen capture failed${name ? ` (${name})` : ''}.`
}

export class HostSession {
  status: HostStatus = 'idle'
  error: string | null = null
  roomCode: string | null = null
  stream: MediaStream | null = null
  hasAudio = false
  rtt: number | null = null
  partner: PartnerStats | null = null
  encoder: EncoderStats | null = null

  private sync = { live: false, mods: 0 }
  private map: { checksum: string; text: string } | null = null
  private clockSeq = 0
  private peer: Peer | null = null
  private audioCalls: MediaConnection[] = []
  private videoCall: MediaConnection | null = null
  private lastRetry = 0
  private guestId: string | null = null
  private ctrl: DataConnection | null = null
  private input: RTCDataChannel | null = null
  private lastAimSeq = 0
  private lastKeySeq = 0
  private inputConfirmed = false
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private lastEncode = { frames: 0, seconds: 0 }

  constructor(
    private guestRole: Role,
    private quality: Quality,
    private handlers: Handlers,
  ) {}

  setGuestRole(role: Role) {
    this.guestRole = role
    this.handlers.onRelease()
    if (this.ctrl?.open) this.ctrl.send({ t: 'welcome', guestRole: role } satisfies HostMessage)
  }

  setQuality(quality: Quality) {
    this.quality = quality
  }

  async start() {
    if (this.status !== 'idle' && this.status !== 'error') return
    this.error = null
    this.setStatus('starting')

    let media: MediaStream
    try {
      media = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: this.quality.fps, max: this.quality.fps } },
        audio: SHARE_AUDIO,
      })
    } catch (err) {
      console.error('[osu-coop] screen capture failed:', err)
      this.error = describeShareError(err)
      this.setStatus('idle')
      return
    }

    const video = media.getVideoTracks()[0]
    if (video) {
      video.contentHint = 'motion'
      video.addEventListener('ended', () => this.stop())
    }
    this.stream = media
    this.hasAudio = media.getAudioTracks().length > 0

    const code = makeRoomCode()
    const peer = new Peer(ROOM_PREFIX + code, { debug: 1, config: { iceServers: ICE_SERVERS } })
    this.peer = peer

    peer.on('open', () => {
      this.roomCode = code
      this.setStatus('waiting')
    })
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') return
      this.error = `Connection error: ${err.type}`
      this.setStatus('error')
    })
    peer.on('disconnected', () => {
      if (!peer.destroyed) peer.reconnect()
    })
    peer.on('connection', (conn) => this.accept(peer, conn))
    this.handlers.onChange()
  }

  stop() {
    this.handlers.onRelease()
    this.closeLink()
    this.peer?.destroy()
    this.peer = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.roomCode = null
    this.rtt = null
    this.partner = null
    this.setStatus('idle')
  }

  publishSync(next: { live: boolean; mods: number }) {
    if (this.sync.live === next.live && this.sync.mods === next.mods) return
    this.sync = next
    if (this.ctrl?.open) this.ctrl.send({ t: 'sync', ...next } satisfies HostMessage)
  }

  publishMap(checksum: string, text: string) {
    this.map = { checksum, text }
    if (this.ctrl?.open) this.sendMap(this.ctrl)
  }

  publishClock(time: number, rate: number, playing: boolean) {
    const input = this.input
    if (input?.readyState !== 'open' || input.bufferedAmount > 1024) return
    input.send(encodeClock(++this.clockSeq, time, rate, playing))
  }

  private setStatus(status: HostStatus) {
    this.status = status
    this.handlers.onChange()
  }

  private accept(peer: Peer, conn: DataConnection) {
    if (this.guestId && this.guestId !== conn.peer) {
      conn.on('open', () => {
        conn.send({ t: 'full' } satisfies HostMessage)
        setTimeout(() => conn.close(), 500)
      })
      return
    }
    this.guestId = conn.peer
    conn.on('data', (raw) => this.handleMessage(raw))
    if (conn.label !== 'ctrl') return

    this.ctrl = conn
    conn.on('open', () => {
      const input = openInputChannel(conn.peerConnection)
      if (input) input.onmessage = (event) => this.handleInput(event)
      this.input = input
      conn.send({ t: 'welcome', guestRole: this.guestRole } satisfies HostMessage)
      conn.send({ t: 'sync', ...this.sync } satisfies HostMessage)
      this.sendMap(conn)
      if (!this.stream) return
      this.callVideo(true)
      // Separate calls keep audio and video in different sync groups, so the video isn't held
      // back to line up with the audio jitter buffer.
      const audio = this.stream.getAudioTracks()
      this.audioCalls = audio.length > 0 ? [peer.call(conn.peer, new MediaStream(audio))] : []
      this.startStats()
      this.setStatus('connected')
    })
    conn.on('close', () => this.dropGuest())
    conn.on('error', () => this.dropGuest())
  }

  // A retry sends the stream untuned with the default codec, in case the hardware encoder
  // rejects the tuned parameters and sends nothing.
  private callVideo(tuned: boolean) {
    const peer = this.peer
    const tracks = this.stream?.getVideoTracks().filter((t) => t.readyState === 'live') ?? []
    if (!peer || peer.destroyed || !this.guestId || tracks.length === 0) return
    this.videoCall?.close()
    const codec = tuned && this.quality.codec === 'h264' ? 'H264' : null
    const call = peer.call(this.guestId, new MediaStream(tracks), {
      sdpTransform: (sdp: string) => (codec ? preferCodec(sdp, codec) : sdp),
    })
    this.videoCall = call
    this.lastEncode = { frames: 0, seconds: 0 }
    const pc = call.peerConnection
    if (!tuned || !pc) return
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') void tuneVideoSenders(pc, this.quality)
    })
  }

  private closeLink() {
    this.stopStats()
    this.audioCalls.forEach((call) => call.close())
    this.audioCalls = []
    this.videoCall?.close()
    this.videoCall = null
    this.input?.close()
    this.input = null
    this.ctrl = null
    this.guestId = null
    this.lastAimSeq = 0
    this.lastKeySeq = 0
    this.inputConfirmed = false
    this.encoder = null
  }

  private dropGuest() {
    this.handlers.onRelease()
    this.closeLink()
    this.rtt = null
    this.partner = null
    this.setStatus(this.peer && !this.peer.destroyed ? 'waiting' : 'idle')
  }

  // Key events come in twice (fast lossy + reliable). Applying strictly in sequence means the
  // first copy wins and a lost fast copy is filled in by the reliable one.
  private applyKey(n: number, slot: TapSlot, down: boolean) {
    if (this.guestRole !== 'tap' || n !== this.lastKeySeq + 1) return
    this.lastKeySeq = n
    this.handlers.onKey(slot, down)
  }

  private applyAim(s: number, x: number, y: number) {
    if (this.guestRole !== 'aim' || s <= this.lastAimSeq) return
    this.lastAimSeq = s
    this.handlers.onAim(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)))
  }

  private handleInput(event: MessageEvent) {
    const packet = decodeInput(event.data)
    if (!packet) return
    if (!this.inputConfirmed && this.ctrl?.open) {
      this.inputConfirmed = true
      this.ctrl.send({ t: 'input-ok' } satisfies HostMessage)
    }
    if (packet.t === 'aim') this.applyAim(packet.s, packet.x, packet.y)
    else if (packet.t === 'key') this.applyKey(packet.n, packet.k, packet.down)
  }

  private handleMessage(raw: unknown) {
    const msg = raw as GuestMessage
    if (!msg || typeof msg !== 'object') return
    switch (msg.t) {
      case 'key':
        if ((msg.k !== 'k1' && msg.k !== 'k2') || typeof msg.n !== 'number') return
        this.applyKey(msg.n, msg.k, Boolean(msg.down))
        break
      case 'aim':
        if (typeof msg.s !== 'number' || typeof msg.x !== 'number' || typeof msg.y !== 'number') return
        this.applyAim(msg.s, msg.x, msg.y)
        break
      case 'release':
        this.handlers.onRelease()
        break
      case 'video-retry': {
        const now = performance.now()
        if (now - this.lastRetry < RETRY_COOLDOWN_MS) return
        this.lastRetry = now
        this.callVideo(false)
        break
      }
      case 'ping': {
        const ctrl = this.ctrl
        ctrl?.send({ t: 'pong', ts: msg.ts } satisfies HostMessage)
        const live = this.stream?.getVideoTracks()[0]?.readyState === 'live'
        ctrl?.send({ t: 'host-video', frames: this.lastEncode.frames, live } satisfies HostMessage)
        const prev = this.partner
        this.partner = {
          rtt: typeof msg.rtt === 'number' ? msg.rtt : (prev?.rtt ?? 0),
          video: typeof msg.video === 'number' ? msg.video : null,
          mode: msg.mode === 'playfield' ? 'playfield' : 'video',
          videoState: VIDEO_STATES.find((s) => s === msg.vs) ?? 'ok',
        }
        if (typeof msg.rtt === 'number') this.rtt = msg.rtt
        this.handlers.onChange()
        break
      }
    }
  }

  private sendMap(conn: DataConnection) {
    const map = this.map
    if (!map) return
    const n = Math.max(1, Math.ceil(map.text.length / MAP_CHUNK_CHARS))
    for (let i = 0; i < n; i++) {
      const d = map.text.slice(i * MAP_CHUNK_CHARS, (i + 1) * MAP_CHUNK_CHARS)
      conn.send({ t: 'map', id: map.checksum, i, n, d } satisfies HostMessage)
    }
  }

  private startStats() {
    this.stopStats()
    this.statsTimer = setInterval(() => void this.readStats(), STATS_INTERVAL_MS)
  }

  private stopStats() {
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null
  }

  private async readStats() {
    const pc = this.videoCall?.peerConnection
    if (!pc) return
    const report = await pc.getStats()
    report.forEach((s) => {
      if (s.type !== 'outbound-rtp' || s.kind !== 'video') return
      const frames: number = s.framesEncoded ?? 0
      const seconds: number = s.totalEncodeTime ?? 0
      const df = frames - this.lastEncode.frames
      const encodeMs = df > 0 ? ((seconds - this.lastEncode.seconds) / df) * 1000 : null
      this.lastEncode = { frames, seconds }
      this.encoder = {
        fps: typeof s.framesPerSecond === 'number' ? s.framesPerSecond : null,
        height: typeof s.frameHeight === 'number' ? s.frameHeight : null,
        encodeMs,
        name: typeof s.encoderImplementation === 'string' ? s.encoderImplementation : null,
        hardware: typeof s.powerEfficientEncoder === 'boolean' ? s.powerEfficientEncoder : null,
        limitation: typeof s.qualityLimitationReason === 'string' ? s.qualityLimitationReason : null,
      }
    })
    this.handlers.onChange()
  }
}
