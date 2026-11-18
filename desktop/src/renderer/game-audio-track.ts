import type { CoopApi } from '../shared/api'

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'audio' | 'video' })
  readonly writable: WritableStream<AudioData>
}

const SAMPLE_RATE = 48000
const CHANNELS = 2
const BYTES_PER_FRAME = 2 * CHANNELS
const MAX_DRIFT_US = 100_000

/** Turns the 16-bit stereo 48 kHz PCM from the main process into a WebRTC audio track. */
export function createGameAudioTrack(api: CoopApi): { track: MediaStreamTrack; dispose(): void } | null {
  if (typeof MediaStreamTrackGenerator === 'undefined' || typeof AudioData === 'undefined') return null
  const generator = new MediaStreamTrackGenerator({ kind: 'audio' })
  const writer = generator.writable.getWriter()
  let nextUs = 0

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
    writer.write(data).catch(() => data.close())
  })
  void api.startGameAudio()

  return {
    track: generator,
    dispose() {
      off()
      api.stopGameAudio()
      writer.close().catch(() => {})
      generator.stop()
    },
  }
}
