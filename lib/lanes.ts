/** osu! ruleset numbers, as tosu and .osu files report them. */
export const RULESET_OSU = 0
export const RULESET_TAIKO = 1
export const RULESET_CATCH = 2
export const RULESET_MANIA = 3

export const MAX_LANES = 10

export type TaikoSplit = 'kat' | 'don' | 'left' | 'right'
export type ManiaSplit = 'right' | 'left' | 'all'

export const TAIKO_LANE_NAMES = ['Left kat', 'Left don', 'Right don', 'Right kat'] as const
/** osu!'s default drum keys: rims on D and K, centres on F and J. */
export const TAIKO_DEFAULT_KEYS = ['KeyD', 'KeyF', 'KeyJ', 'KeyK']

const LEFT_HAND = ['KeyA', 'KeyS', 'KeyD', 'KeyF']
const RIGHT_HAND = ['KeyJ', 'KeyK', 'KeyL', 'Semicolon']

/** osu!'s default mania layout for a key count: home row outward from F and J, Space in the middle on odd counts. */
export function maniaDefaultKeys(count: number): string[] {
  const n = Math.min(MAX_LANES, Math.max(1, Math.round(count)))
  if (n === 10) return ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyV', 'KeyN', 'KeyU', 'KeyI', 'KeyO', 'KeyP']
  const half = Math.floor(n / 2)
  const middle = n % 2 === 1 ? ['Space'] : []
  return [...LEFT_HAND.slice(4 - half), ...middle, ...RIGHT_HAND.slice(0, half)]
}

export function isLaneRuleset(ruleset: number | null | undefined): ruleset is 1 | 3 {
  return ruleset === RULESET_TAIKO || ruleset === RULESET_MANIA
}

export function laneCount(ruleset: number, keys: number | null) {
  if (ruleset === RULESET_TAIKO) return 4
  return keys ? Math.min(MAX_LANES, Math.max(1, Math.round(keys))) : 0
}

/** Which lanes the partner plays; the host keeps the rest on their own keyboard. */
export function partnerLanes(ruleset: number, keys: number | null, taiko: TaikoSplit, mania: ManiaSplit): number[] {
  if (ruleset === RULESET_TAIKO) {
    if (taiko === 'kat') return [0, 3]
    if (taiko === 'don') return [1, 2]
    if (taiko === 'left') return [0, 1]
    return [2, 3]
  }
  const n = laneCount(ruleset, keys)
  const all = Array.from({ length: n }, (_, i) => i)
  if (mania === 'all') return all
  // The middle column of an odd layout stays with the host.
  const half = Math.floor(n / 2)
  return mania === 'left' ? all.slice(0, half) : all.slice(n - half)
}

export function laneName(ruleset: number, lane: number) {
  return ruleset === RULESET_TAIKO ? (TAIKO_LANE_NAMES[lane] ?? `Drum ${lane + 1}`) : `Column ${lane + 1}`
}

const CODE_LABELS: Record<string, string> = {
  Space: 'Space',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  ShiftLeft: 'L Shift',
  ShiftRight: 'R Shift',
  ControlLeft: 'L Ctrl',
  ControlRight: 'R Ctrl',
  AltLeft: 'L Alt',
  AltRight: 'R Alt',
}

/** The `KeyboardEvent.key` value (lowercased, as KeyCapture stores it) a code produces on QWERTY. */
export function codeToKey(code: string) {
  if (code === 'Space') return ' '
  const label = codeLabel(code)
  return label.length === 1 ? label.toLowerCase() : label
}

/** osu!'s default keys for every lane of a layout, in the partner's key format. */
export function defaultLaneKeys(ruleset: number, keys: number | null) {
  const codes = ruleset === RULESET_TAIKO ? TAIKO_DEFAULT_KEYS : maniaDefaultKeys(laneCount(ruleset, keys))
  return codes.map(codeToKey)
}

export function layoutId(ruleset: number, keys: number | null) {
  return ruleset === RULESET_TAIKO ? 'taiko' : `mania-${laneCount(ruleset, keys)}`
}

/** Short label for a KeyboardEvent.code value. */
export function codeLabel(code: string) {
  if (code in CODE_LABELS) return CODE_LABELS[code]
  const match = /^(?:Key|Digit)(.)$/.exec(code)
  if (match) return match[1]
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`
  if (code.startsWith('Arrow')) return code.slice(5)
  return code
}
