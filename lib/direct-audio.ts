import { decodeAudioPacket } from '@/lib/protocol'

const SAMPLE_RATE = 48000
const CHANNELS = 2
const MIN_TARGET_MS = 4
const MAX_TARGET_MS = 60
// Arrival spread over about the last second of 5 ms packets.
const JITTER_WINDOW = 200
const TARGET_UPDATE_MS = 250

/** 5 ms Opus frame plus 2.5 ms low-delay lookahead on the host. */
export const DIRECT_PACKET_MS = 8

/**
 * Plays decoded sound from a ring buffer that starts once it holds `target` samples, rebuffers
 * on underrun, and skips ahead when it has been sitting on more than it needs.
 */
const WORKLET_SOURCE = `
class DosuDirectAudio extends AudioWorkletProcessor {
  constructor() {
    super()
    this.cap = 48000
    this.l = new Float32Array(this.cap)
    this.r = new Float32Array(this.cap)
    this.read = 0
    this.write = 0
    this.target = 480
    this.playing = false
    this.sum = 0
    this.count = 0
    this.min = Infinity
    this.port.onmessage = (e) => {
      const m = e.data
      if (m.t === 'pcm') this.push(m.l, m.r)
      else if (m.t === 'target') this.target = m.v
      else if (m.t === 'reset') { this.read = this.write; this.playing = false }
    }
  }
  push(l, r) {
    for (let i = 0; i < l.length; i++) {
      const k = (this.write + i) % this.cap
      this.l[k] = l[i]
      this.r[k] = r[i]
    }
    this.write += l.length
    if (this.write - this.read > this.cap) this.read = this.write - this.cap
  }
  process(_inputs, outputs) {
    const out = outputs[0]
    const L = out[0]
    const R = out[1] || out[0]
    const frames = L.length
    let avail = this.write - this.read
    if (avail > this.target + 4800) {
      this.read = this.write - this.target
      avail = this.target
    }
    if (!this.playing && avail >= this.target) this.playing = true
    if (this.playing) {
      const n = Math.min(frames, avail)
      for (let i = 0; i < n; i++) {
        const k = (this.read + i) % this.cap
        L[i] = this.l[k]
        R[i] = this.r[k]
      }
      for (let i = n; i < frames; i++) { L[i] = 0; R[i] = 0 }
      this.read += n
      if (n < frames) this.playing = false
      if (avail < this.min) this.min = avail
    }
    this.sum += avail
    this.count++
    if (this.count >= 94) {
      if (this.playing && this.min !== Infinity && this.min > this.target + 96) this.read += this.min - this.target
      this.port.postMessage({ avg: this.sum / this.count })
      this.sum = 0
      this.count = 0
      this.min = Infinity
    }
    return true
  }
}
registerProcessor('dosu-direct-audio', DosuDirectAudio)
`

export function directAudioSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof AudioDecoder !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof EncodedAudioChunk !== 'undefined'
  )
}

/**
 * Receives the host's Opus packets and plays them with a buffer sized to the measured arrival
 * spread, instead of WebRTC's fixed 20 ms packets and its own jitter buffer.
 */
export class DirectAudio {
  /** Average sound held before playing, in ms; null until playback starts. */
  bufferMs: number | null = null
  active = false

  private ctx: AudioContext
  private node: AudioWorkletNode | null = null
  private decoder: AudioDecoder | null = null
  private ready: Promise<boolean>
  private lastSeq = 0
  private transits: number[] = []
  private targetMs = 10
  private lastTargetUpdate = 0
  private closed = false
  private readonly resume = () => {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  constructor(private onActive: () => void) {
    // Created inside the join click where possible, so autoplay rules let it start.
    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: SAMPLE_RATE })
    window.addEventListener('pointerdown', this.resume)
    window.addEventListener('keydown', this.resume)
    this.ready = this.setup()
  }

  private async setup() {
    try {
      const { supported } = await AudioDecoder.isConfigSupported({
        codec: 'opus',
        sampleRate: SAMPLE_RATE,
        numberOfChannels: CHANNELS,
      })
      if (!supported || this.closed) return false
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
      try {
        await this.ctx.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      if (this.closed) return false
      const node = new AudioWorkletNode(this.ctx, 'dosu-direct-audio', {
        numberOfInputs: 0,
        outputChannelCount: [CHANNELS],
      })
      node.port.onmessage = (event: MessageEvent<{ avg: number }>) => {
        if (this.active) this.bufferMs = (event.data.avg / SAMPLE_RATE) * 1000
      }
      node.connect(this.ctx.destination)
      this.node = node
      this.postTarget()
      this.resume()
      return true
    } catch (err) {
      console.warn('[duosu] direct audio unavailable:', err)
      return false
    }
  }

  private makeDecoder() {
    const decoder = new AudioDecoder({
      output: (data) => this.play(data),
      error: (err) => {
        console.warn('[duosu] opus decoder error:', err)
        if (this.decoder === decoder) this.decoder = null
      },
    })
    decoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS })
    return decoder
  }

  private play(data: AudioData) {
    const node = this.node
    if (!node) return data.close()
    const frames = data.numberOfFrames
    const l = new Float32Array(frames)
    const r = new Float32Array(frames)
    try {
      data.copyTo(l, { planeIndex: 0, format: 'f32-planar' })
      if (data.numberOfChannels > 1) data.copyTo(r, { planeIndex: 1, format: 'f32-planar' })
      else r.set(l)
    } finally {
      data.close()
    }
    node.port.postMessage({ t: 'pcm', l, r }, [l.buffer, r.buffer])
    if (!this.active) {
      this.active = true
      this.onActive()
    }
  }

  receive(raw: unknown) {
    if (this.closed || !this.node) return
    const packet = decodeAudioPacket(raw)
    if (!packet) return
    // Unordered channel: a packet older than one already played is too late to use.
    if (this.lastSeq !== 0 && packet.seq <= this.lastSeq && this.lastSeq - packet.seq < 1_000_000) return
    this.lastSeq = packet.seq
    this.trackJitter(performance.now() - packet.sentMs)
    try {
      this.decoder ??= this.makeDecoder()
      this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: packet.seq * 5000, data: packet.opus }))
    } catch {
      this.decoder = null
    }
  }

  /** The two clocks differ by a fixed offset, so the spread of transit times is the jitter. */
  private trackJitter(transit: number) {
    const list = this.transits
    list.push(transit)
    if (list.length > JITTER_WINDOW) list.shift()
    const now = performance.now()
    if (list.length < 20 || now - this.lastTargetUpdate < TARGET_UPDATE_MS) return
    this.lastTargetUpdate = now
    const sorted = [...list].sort((a, b) => a - b)
    const spread = sorted[Math.floor(sorted.length * 0.97)] - sorted[0]
    const next = Math.min(MAX_TARGET_MS, Math.max(MIN_TARGET_MS, spread + 2))
    if (Math.abs(next - this.targetMs) < 0.5) return
    this.targetMs = next
    this.postTarget()
  }

  private postTarget() {
    this.node?.port.postMessage({ t: 'target', v: Math.round((this.targetMs / 1000) * SAMPLE_RATE) })
  }

  /** Forget the old link so the next host's packets start fresh. */
  reset() {
    this.lastSeq = 0
    this.transits = []
    this.active = false
    this.bufferMs = null
    this.node?.port.postMessage({ t: 'reset' })
  }

  async isReady() {
    return this.ready
  }

  close() {
    this.closed = true
    window.removeEventListener('pointerdown', this.resume)
    window.removeEventListener('keydown', this.resume)
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    this.decoder = null
    this.node?.disconnect()
    this.node = null
    void this.ctx.close().catch(() => {})
  }
}
