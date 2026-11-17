/** Windows virtual-key codes for KeyboardEvent.code values. */
const NAMED: Record<string, number> = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  CapsLock: 0x14,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Insert: 0x2d,
  Delete: 0x2e,
  ShiftLeft: 0xa0,
  ShiftRight: 0xa1,
  ControlLeft: 0xa2,
  ControlRight: 0xa3,
  AltLeft: 0xa4,
  AltRight: 0xa5,
  Semicolon: 0xba,
  Equal: 0xbb,
  Comma: 0xbc,
  Minus: 0xbd,
  Period: 0xbe,
  Slash: 0xbf,
  Backquote: 0xc0,
  BracketLeft: 0xdb,
  Backslash: 0xdc,
  BracketRight: 0xdd,
  Quote: 0xde,
  NumpadMultiply: 0x6a,
  NumpadAdd: 0x6b,
  NumpadSubtract: 0x6d,
  NumpadDecimal: 0x6e,
  NumpadDivide: 0x6f,
}

const LABELS: Record<string, string> = {
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Semicolon: ';',
  Equal: '=',
  Comma: ',',
  Minus: '-',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Quote: "'",
}

export function virtualKeyFor(code: string): number | null {
  if (code in NAMED) return NAMED[code]
  let match = /^Key([A-Z])$/.exec(code)
  if (match) return match[1].charCodeAt(0)
  match = /^Digit([0-9])$/.exec(code)
  if (match) return 0x30 + Number(match[1])
  match = /^Numpad([0-9])$/.exec(code)
  if (match) return 0x60 + Number(match[1])
  match = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
  if (match) return 0x6f + Number(match[1])
  return null
}

export function keyLabel(code: string) {
  if (code in LABELS) return LABELS[code]
  const match = /^(?:Key|Digit)(.)$/.exec(code)
  if (match) return match[1]
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`
  return code
}
