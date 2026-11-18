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
import { createGameAudioTrack } from './game-audio-track'

export type HostStatus = 'idle' | 'starting' | 'waiting' | 'connected' | 'error'

export type Quality = { fps: 60 | 120; height: 720 | 1080; codec: 'h264' | 'auto' }

export type EncoderStats = {
  fps: number | null
  height: number | null
  encodeMs: number | null
  name: string | null
  hardware: boolean | null
  limitation: string | null
  link: RTCPeerConnectionState | 'none'
  linkNote: string | null
  captureFps: number | null
  framesEncoded: number
  track: 'live' | 'muted' | 'ended' | 'none'
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
const VIDEO_RECALL_MS = 2000
const VIDEO_RECALL_LIMIT = 5

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

  private gameAudio: ReturnType<typeof createGameAudioTrack> = null
  private sync: { live: boolean; mods: number; map: string | null } = { live: false, mods: 0, map: null }
  private map: { checksum: string; text: string } | null = null
  private skin: { id: string; text: string } | null = null
  private clockSeq = 0
  private peer: Peer | null = null
  private audioCalls: MediaConnection[] = []
  private videoCall: MediaConnection | null = null
  private videoNote: string | null = null
  private videoIce: string | null = null
  private videoRecalls = 0
  private videoRecallTimer: ReturnType<typeof setTimeout> | null = null
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
        audio: false,
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
    this.gameAudio = createGameAudioTrack(window.coop)
    if (this.gameAudio) media.addTrack(this.gameAudio.track)
    this.stream = media
    this.hasAudio = media.getAudioTracks().length > 0

    const code = makeRoomCode()
    const peer = new Peer(ROOM_PREFIX + code, { debug: 1, config: { iceServers: ICE_SERVERS } })
    this.peer = peer

    peer.on('open', () => {
      this.roomCode = code
      if (this.ctrl?.open) {
        if (!this.videoCall) {
          this.videoRecalls = 0
          this.callVideo(false)
        }
        return
      }
      this.setStatus('waiting')
    })
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') return
      if (this.ctrl?.open && (err.type === 'disconnected' || err.type === 'network' || err.type === 'server-error')) {
        this.videoNote = `signaling ${err.type}, retrying`
        return
      }
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
    this.gameAudio?.dispose()
    this.gameAudio = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.roomCode = null
    this.rtt = null
    this.partner = null
    this.setStatus('idle')
  }

  publishSync(next: { live: boolean; mods: number; map: string | null }) {
    if (this.sync.live === next.live && this.sync.mods === next.mods && this.sync.map === next.map) return
    this.sync = next
    if (this.ctrl?.open) this.ctrl.send({ t: 'sync', ...next } satisfies HostMessage)
  }

  publishMap(checksum: string, text: string) {
    this.map = { checksum, text }
    if (this.ctrl?.open) this.sendMap(this.ctrl)
  }

  publishSkin(skin: { id: string; ini: string | null; images: Record<string, { hd: boolean; data: string }> }) {
    this.skin = { id: skin.id, text: JSON.stringify({ ini: skin.ini, images: skin.images }) }
    if (this.ctrl?.open) this.sendSkin(this.ctrl)
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
    if (this.guestId && this.guestId !== conn.peer && this.ctrl?.open) {
      conn.on('open', () => {
        conn.send({ t: 'full' } satisfies HostMessage)
        setTimeout(() => conn.close(), 500)
      })
      return
    }
    if (conn.label === 'ctrl' && this.ctrl && this.ctrl !== conn) {
      // The partner reconnected. Tear the old link down now so its late close event can't wipe
      // out the new session's video call.
      const old = this.ctrl
      this.closeLink()
      old.close()
    } else if (this.guestId && this.guestId !== conn.peer) {
      this.closeLink()
    }
    this.guestId = conn.peer
    conn.on('data', (raw) => this.handleMessage(raw, conn))
    if (conn.label !== 'ctrl') return

    this.ctrl = conn
    conn.on('open', () => {
      if (this.ctrl !== conn) return
      const input = openInputChannel(conn.peerConnection)
      if (input) input.onmessage = (event) => this.handleInput(event)
      this.input = input
      conn.send({ t: 'welcome', guestRole: this.guestRole } satisfies HostMessage)
      conn.send({ t: 'sync', ...this.sync } satisfies HostMessage)
      this.sendMap(conn)
      this.sendSkin(conn)
      this.startStats()
      if (!this.stream) {
        this.videoNote = 'no screen capture'
        return
      }
      this.guestId = conn.peer
      this.callVideo(true, conn.peer)
      // Separate calls keep audio and video in different sync groups, so the video isn't held
      // back to line up with the audio jitter buffer.
      const audio = this.stream.getAudioTracks()
      this.audioCalls = audio.length > 0 ? [peer.call(conn.peer, new MediaStream(audio))].filter(Boolean) : []
      this.setStatus('connected')
    })
    conn.on('close', () => {
      if (this.ctrl === conn) this.dropGuest()
    })
    // PeerJS reports some recoverable problems as errors while the link keeps working, so only
    // drop the partner if the link actually went down.
    conn.on('error', (err) => {
      console.warn('[osu-coop] ctrl link error:', err)
      if (this.ctrl === conn && !conn.open) this.dropGuest()
    })
  }

  // A retry sends the stream untuned with the default codec, in case the hardware encoder
  // rejects the tuned parameters and sends nothing.
  private callVideo(tuned: boolean, target?: string) {
    const peer = this.peer
    const tracks = this.stream?.getVideoTracks().filter((t) => t.readyState === 'live') ?? []
    if (!peer || peer.destroyed) {
      this.videoNote = 'host peer closed'
      console.warn('[osu-coop] video call skipped:', this.videoNote)
      return
    }
    const partnerId = target ?? this.ctrl?.peer ?? this.guestId
    if (!partnerId) {
      this.videoNote = `no partner id (link ${this.ctrl ? (this.ctrl.open ? 'open' : 'not open') : 'missing'})`
      console.warn('[osu-coop] video call skipped:', this.videoNote)
      return
    }
    this.guestId = partnerId
    if (tracks.length === 0) {
      this.videoNote = 'no live capture track'
      return
    }
    this.clearVideoRecall()
    this.dropVideoCall()
    const codec = tuned && this.quality.codec === 'h264' ? 'H264' : null
    // PeerJS returns undefined instead of a call while the host is cut off from the signaling
    // server, even though the existing data link to the partner keeps working.
    let call: MediaConnection | undefined
    try {
      call = peer.call(partnerId, new MediaStream(tracks), {
        sdpTransform: (sdp: string) => (codec ? preferCodec(sdp, codec) : sdp),
      })
    } catch (err) {
      console.error('[osu-coop] video call threw:', err)
      this.videoNote = `call threw: ${err instanceof Error ? err.message : String(err)}`
      this.scheduleVideoRecall()
      return
    }
    if (!call) {
      this.videoNote = peer.disconnected ? 'signaling server offline, retrying' : 'call could not start'
      console.warn('[osu-coop] video call not created:', this.videoNote)
      this.scheduleVideoRecall()
      return
    }
    this.videoCall = call
    this.videoNote = 'negotiating'
    this.videoIce = null
    this.lastEncode = { frames: 0, seconds: 0 }

    call.on('error', (err) => {
      console.error('[osu-coop] video call error:', err)
      if (this.videoCall === call) this.videoNote = `${err.type}: ${err.message}`
    })
    call.on('iceStateChanged', (state) => {
      if (this.videoCall === call) this.videoIce = state
    })
    // PeerJS closes the call on its own when ICE fails or negotiation errors, which leaves the
    // partner with no video. Call again, untuned, so a rejected codec setting can't stick.
    call.on('close', () => {
      if (this.videoCall !== call) return
      this.videoCall = null
      if (!this.videoNote || this.videoNote === 'negotiating') {
        this.videoNote = `closed, ICE ${this.videoIce ?? 'never started'}`
      }
      console.warn('[osu-coop] video call closed:', this.videoNote)
      this.scheduleVideoRecall()
    })

    const pc = call.peerConnection
    if (!pc) return
    pc.addEventListener('connectionstatechange', () => {
      if (this.videoCall !== call) return
      if (pc.connectionState === 'connected') {
        this.videoNote = null
        this.videoRecalls = 0
        if (tuned) void tuneVideoSenders(pc, this.quality)
      }
    })
  }

  private dropVideoCall() {
    const call = this.videoCall
    this.videoCall = null
    call?.close()
  }

  private scheduleVideoRecall() {
    if (this.videoRecallTimer || !this.ctrl?.open) return
    if (this.videoRecalls >= VIDEO_RECALL_LIMIT) {
      this.videoNote = `${this.videoNote ?? 'no call'}; gave up after ${VIDEO_RECALL_LIMIT} tries`
      return
    }
    this.videoRecalls++
    this.videoRecallTimer = setTimeout(() => {
      this.videoRecallTimer = null
      if (this.ctrl?.open && !this.videoCall) this.callVideo(false)
    }, VIDEO_RECALL_MS)
  }

  private clearVideoRecall() {
    if (this.videoRecallTimer) clearTimeout(this.videoRecallTimer)
    this.videoRecallTimer = null
  }

  private closeLink() {
    this.stopStats()
    this.audioCalls.forEach((call) => call.close())
    this.audioCalls = []
    this.clearVideoRecall()
    this.dropVideoCall()
    this.videoNote = null
    this.videoIce = null
    this.videoRecalls = 0
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

  private handleMessage(raw: unknown, from: DataConnection) {
    const msg = raw as GuestMessage
    if (!msg || typeof msg !== 'object') return
    // The partner is still talking on a link the host already let go of, so take it back.
    if (!this.ctrl && from.label === 'ctrl' && from.open) {
      console.warn('[osu-coop] re-adopting live partner link')
      this.ctrl = from
      this.guestId = from.peer
      this.startStats()
      this.setStatus('connected')
    }
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
        this.videoRecalls = 0
        this.callVideo(false, from.peer)
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

  private sendSkin(conn: DataConnection) {
    const skin = this.skin
    if (!skin) return
    const n = Math.max(1, Math.ceil(skin.text.length / MAP_CHUNK_CHARS))
    for (let i = 0; i < n; i++) {
      const d = skin.text.slice(i * MAP_CHUNK_CHARS, (i + 1) * MAP_CHUNK_CHARS)
      conn.send({ t: 'skin', id: skin.id, i, n, d } satisfies HostMessage)
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
    if (this.ctrl?.open && this.stream && !this.videoCall && !this.videoRecallTimer && this.videoRecalls < VIDEO_RECALL_LIMIT) {
      console.warn('[osu-coop] partner connected without a video call, calling again')
      this.scheduleVideoRecall()
    }
    const pc = this.videoCall?.peerConnection
    const track = this.stream?.getVideoTracks()[0]
    const next: EncoderStats = {
      fps: null,
      height: null,
      encodeMs: null,
      name: null,
      hardware: null,
      limitation: null,
      link: pc?.connectionState ?? 'none',
      linkNote: this.videoNote ?? (this.videoCall ? null : 'no call started'),
      captureFps: null,
      framesEncoded: 0,
      track: !track ? 'none' : track.readyState === 'ended' ? 'ended' : track.muted ? 'muted' : 'live',
    }
    if (pc) {
      const report = await pc.getStats()
      report.forEach((s) => {
        if (s.kind !== 'video') return
        if (s.type === 'media-source') {
          if (typeof s.framesPerSecond === 'number') next.captureFps = s.framesPerSecond
          return
        }
        if (s.type !== 'outbound-rtp') return
        const frames: number = s.framesEncoded ?? 0
        const seconds: number = s.totalEncodeTime ?? 0
        const df = frames - this.lastEncode.frames
        next.encodeMs = df > 0 ? ((seconds - this.lastEncode.seconds) / df) * 1000 : null
        this.lastEncode = { frames, seconds }
        next.framesEncoded = frames
        next.fps = typeof s.framesPerSecond === 'number' ? s.framesPerSecond : null
        next.height = typeof s.frameHeight === 'number' ? s.frameHeight : null
        next.name = typeof s.encoderImplementation === 'string' ? s.encoderImplementation : null
        next.hardware = typeof s.powerEfficientEncoder === 'boolean' ? s.powerEfficientEncoder : null
        next.limitation = typeof s.qualityLimitationReason === 'string' ? s.qualityLimitationReason : null
      })
    }
    this.encoder = next
    this.handlers.onChange()
  }
}
