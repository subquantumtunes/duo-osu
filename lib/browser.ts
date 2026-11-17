export type BrowserName = 'opera-gx' | 'opera' | 'edge' | 'chrome' | 'firefox' | 'safari' | 'other'

type UADataNavigator = Navigator & { userAgentData?: { brands?: { brand: string }[] } }

export function detectBrowser(): BrowserName {
  if (typeof navigator === 'undefined') return 'other'
  const brands = (navigator as UADataNavigator).userAgentData?.brands?.map((b) => b.brand.toLowerCase()) ?? []
  const ua = navigator.userAgent
  if (brands.some((b) => b.includes('opera gx')) || /OPRGX\//.test(ua)) return 'opera-gx'
  if (brands.some((b) => b.includes('opera')) || /\bOPR\//.test(ua)) return 'opera'
  if (/\bEdg\//.test(ua)) return 'edge'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrome\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua)) return 'safari'
  return 'other'
}

export const isOpera = (name: BrowserName) => name === 'opera' || name === 'opera-gx'

export const SUPPORTED_BROWSERS = 'Chrome, Edge, Opera or Firefox'

/**
 * STUN only. PeerJS's old public TURN hosts (eu-0/us-0.turn.peerjs.com) no longer resolve, so
 * listing them just flooded logs with DNS errors. Add a TURN provider here if peers behind strict
 * NATs or Opera's "disable non-proxied UDP" setting can't connect.
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
]
