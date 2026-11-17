import type { Rectangle } from 'electron'
import type { TapSlot } from '../shared/api'
import { virtualKeyFor } from '../shared/keys'

export type Injector = {
  native: boolean
  reason: string | null
  setRegion(region: Rectangle): void
  setBindings(k1: string, k2: string): boolean
  aim(x: number, y: number): void
  key(slot: TapSlot, down: boolean): void
  releaseAll(): void
  dispose(): void
}

function unsupported(reason: string): Injector {
  return {
    native: false,
    reason,
    setRegion() {},
    setBindings: () => false,
    aim() {},
    key() {},
    releaseAll() {},
    dispose() {},
  }
}

export function createInjector(): Injector {
  if (process.platform !== 'win32') {
    return unsupported('Native input is Windows only. On this system, keep using the Python bridge with the web host.')
  }
  try {
    return createWindowsInjector()
  } catch (err) {
    return unsupported(`Couldn't load the Windows input API (${err instanceof Error ? err.message : String(err)}).`)
  }
}

const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_VIRTUALDESK = 0x4000
const MOUSEEVENTF_ABSOLUTE = 0x8000
const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_SCANCODE = 0x0008
const MAPVK_VK_TO_VSC_EX = 4
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const SM_CXVIRTUALSCREEN = 78
const SM_CYVIRTUALSCREEN = 79

type KeyStroke = { vk: number; scan: number; extended: boolean }

function createWindowsInjector(): Injector {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as typeof import('koffi')

  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'long',
    dy: 'long',
    mouseData: 'uint32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t',
  })
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t',
  })
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' })
  const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT })
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION })
  const inputSize = koffi.sizeof(INPUT)

  const user32 = koffi.load('user32.dll')
  const winmm = koffi.load('winmm.dll')
  const SendInput = user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int'])
  const GetSystemMetrics = user32.func('__stdcall', 'GetSystemMetrics', 'int', ['int'])
  const MapVirtualKeyW = user32.func('__stdcall', 'MapVirtualKeyW', 'uint32', ['uint32', 'uint32'])
  const timeBeginPeriod = winmm.func('__stdcall', 'timeBeginPeriod', 'uint32', ['uint32'])
  const timeEndPeriod = winmm.func('__stdcall', 'timeEndPeriod', 'uint32', ['uint32'])

  // 1 ms scheduler ticks keep the event loop from batching input on the default 15.6 ms timer.
  timeBeginPeriod(1)

  let region: Rectangle = { x: 0, y: 0, width: GetSystemMetrics(0), height: GetSystemMetrics(1) }
  let bindings: Record<TapSlot, KeyStroke | null> = { k1: stroke('KeyZ'), k2: stroke('KeyX') }
  const held = new Set<TapSlot>()

  function stroke(code: string): KeyStroke | null {
    const vk = virtualKeyFor(code)
    if (vk === null) return null
    const mapped = Number(MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX))
    return { vk, scan: mapped & 0xff, extended: (mapped & 0xff00) === 0xe000 }
  }

  // Scan codes reach games that read raw keyboard input; the virtual key is a fallback for
  // keys without one.
  function sendKey(key: KeyStroke, down: boolean) {
    const useScan = key.scan !== 0
    let flags = down ? 0 : KEYEVENTF_KEYUP
    if (useScan) flags |= KEYEVENTF_SCANCODE
    if (key.extended) flags |= KEYEVENTF_EXTENDEDKEY
    SendInput(
      1,
      {
        type: INPUT_KEYBOARD,
        u: { ki: { wVk: useScan ? 0 : key.vk, wScan: key.scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
      },
      inputSize,
    )
  }

  function key(slot: TapSlot, down: boolean) {
    const binding = bindings[slot]
    if (!binding) return
    if (down && !held.has(slot)) {
      held.add(slot)
      sendKey(binding, true)
    } else if (!down && held.has(slot)) {
      held.delete(slot)
      sendKey(binding, false)
    }
  }

  function releaseAll() {
    for (const slot of [...held]) key(slot, false)
  }

  return {
    native: true,
    reason: null,
    setRegion(next) {
      region = next
    },
    setBindings(k1, k2) {
      const next = { k1: stroke(k1), k2: stroke(k2) }
      if (!next.k1 || !next.k2) return false
      releaseAll()
      bindings = next
      return true
    },
    // Absolute moves on the virtual desktop reach osu! with Raw input on, the way a tablet does.
    aim(x, y) {
      const px = region.x + x * (region.width - 1)
      const py = region.y + y * (region.height - 1)
      const vx = GetSystemMetrics(SM_XVIRTUALSCREEN)
      const vy = GetSystemMetrics(SM_YVIRTUALSCREEN)
      const vw = GetSystemMetrics(SM_CXVIRTUALSCREEN)
      const vh = GetSystemMetrics(SM_CYVIRTUALSCREEN)
      if (vw <= 1 || vh <= 1) return
      SendInput(
        1,
        {
          type: INPUT_MOUSE,
          u: {
            mi: {
              dx: Math.round(((px - vx) * 65535) / (vw - 1)),
              dy: Math.round(((py - vy) * 65535) / (vh - 1)),
              mouseData: 0,
              dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
              time: 0,
              dwExtraInfo: 0,
            },
          },
        },
        inputSize,
      )
    },
    key,
    releaseAll,
    dispose() {
      releaseAll()
      timeEndPeriod(1)
    },
  }
}
