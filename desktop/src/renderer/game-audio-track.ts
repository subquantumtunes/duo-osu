import type { CoopApi } from '../shared/api'

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'audio' | 'video' })
  readonly writable: WritableStream<AudioData>
}

const SAMPLE_RATE = 48000
const CHANNELS = 2
const BYTES_PER_FRAME = 2 * CHANNELS
const MAX_DRIFT_US = 100_000
const OPUS_BITRATE = 128_000
// Past this many queued frames the encoder can't keep up; dropping is better than falling behind.
const MAX_ENCODE_QUEUE = 16

/**
 * 5 ms frames in low-delay mode add about 7.5 ms before a packet exists, against roughly 26 ms
 * for WebRTC's 20 ms default. Older Chromium builds ignore or reject some of these, so fall back.
 */
const OPUS_CONFIGS = [
  { frameDuration: 5000, application: 'lowdelay', complexity: 5, usedtx: false },
  { frameDuration: 5000, complexity: 5 },
  { frameDuration: 10000 },
]

export type OpusSink = (packet: Uint8Array) => void

async function createOpusEncoder(onPacket: OpusSink): Promise<AudioEncoder | null> {
  if (typeof AudioEncoder === 'undefined') return null
  for (const opus of OPUS_CONFIGS) {
    const config = {
      codec: 'opus',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate: OPUS_BITRATE,
      opus,
    } as AudioEncoderConfig
    try {
      const { supported } = await AudioEncoder.isConfigSupported(config)
      if (!supported) continue
      const encoder = new AudioEncoder({
        output: (chunk) => {
          const bytes = new Uint8Array(chunk.byteLength)
          chunk.copyTo(bytes)
          onPacket(bytes)
        },
        error: (err) => console.warn('[duosu] opus encoder error:', err),
      })
      encoder.configure(config)
      return encoder
    } catch {}
  }
  return null
}

/**
 * Turns the 16-bit stereo 48 kHz PCM from the main process into a WebRTC audio track, and, when
 * a sink is set, into Opus packets for the partner's direct low-latency path.
 */
export function createGameAudioTrack(api: CoopApi) {
  if (typeof MediaStreamTrackGenerator === 'undefined' || typeof AudioData === 'undefined') return null
  const generator = new MediaStreamTrackGenerator({ kind: 'audio' })
  const writer = generator.writable.getWriter()
  let nextUs = 0
  let sink: OpusSink | null = null
  let encoder: AudioEncoder | null = null
  let encoderPending = false

  const closeEncoder = () => {
    if (encoder && encoder.state !== 'closed') encoder.close()
    encoder = null
  }

  const ensureEncoder = () => {
    if (encoder || encoderPending) return
    encoderPending = true
    void createOpusEncoder((packet) => sink?.(packet)).then((created) => {
      encoderPending = false
      if (sink && created) encoder = created
      else if (created) created.close()
    })
  }

  const off = api.onGameAudio((chunk) => {
    const frames = Math.floor(chunk.byteLength / BYTES_PER_FRAME)
    if (frames === 0) return
    // After silence (osu! sends nothing while idle) jump forward instead of queueing old audio.
    const nowUs = performance.now() * 1000
    if (nowUs - nextUs > MAX_DRIFT_US) nextUs = nowUs
    const data = new AudioData({
      format: 's16',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      numberOfFrames: frames,
      timestamp: nextUs,
      data: chunk.subarray(0, frames * BYTES_PER_FRAME),
    })
    nextUs += (frames * 1e6) / SAMPLE_RATE
    if (encoder?.state === 'configured' && encoder.encodeQueueSize < MAX_ENCODE_QUEUE) {
      try {
        encoder.encode(data)
      } catch {}
    }
    writer.write(data).catch(() => data.close())
  })
  void api.startGameAudio()

  return {
    track: generator as MediaStreamTrack,
    setOpusSink(next: OpusSink | null) {
      sink = next
      if (next) ensureEncoder()
      else closeEncoder()
    },
    dispose() {
      off()
      sink = null
      closeEncoder()
      api.stopGameAudio()
      writer.close().catch(() => {})
      generator.stop()
    },
  }
}
