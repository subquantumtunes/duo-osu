import path from 'node:path'
import type { Rectangle } from 'electron'

export type WindowTools = {
  /** Visible bounds in physical pixels (what the capture shows and SendInput uses), or null if minimized or gone. */
  bounds(hwnd: number): Rectangle | null
  alive(hwnd: number): boolean
  /** Lowercased file name of the executable that owns the window. */
  exeName(hwnd: number): string | null
}

const DWMWA_EXTENDED_FRAME_BOUNDS = 9
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/** desktopCapturer window ids look like `window:<hwnd>:0`. */
export function hwndFromSourceId(id: string): number | null {
  const match = /^window:(\d+):/.exec(id)
  if (!match) return null
  const hwnd = Number(match[1])
  return Number.isSafeInteger(hwnd) && hwnd > 0 ? hwnd : null
}

export function createWindowTools(): WindowTools | null {
  if (process.platform !== 'win32') return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi')
    const RECT = koffi.struct('DUOSU_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
    const user32 = koffi.load('user32.dll')
    const dwmapi = koffi.load('dwmapi.dll')
    const kernel32 = koffi.load('kernel32.dll')
    const IsWindow = user32.func('__stdcall', 'IsWindow', 'bool', ['uintptr_t'])
    const IsIconic = user32.func('__stdcall', 'IsIconic', 'bool', ['uintptr_t'])
    const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', [
      'uintptr_t',
      koffi.out(koffi.pointer('uint32')),
    ])
    const DwmGetWindowAttribute = dwmapi.func('__stdcall', 'DwmGetWindowAttribute', 'long', [
      'uintptr_t',
      'uint32',
      koffi.out(koffi.pointer(RECT)),
      'uint32',
    ])
    const OpenProcess = kernel32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'bool', 'uint32'])
    const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void *'])
    const QueryFullProcessImageNameW = kernel32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', [
      'void *',
      'uint32',
      'void *',
      koffi.inout(koffi.pointer('uint32')),
    ])
    const rectSize = koffi.sizeof(RECT)

    return {
      alive: (hwnd) => IsWindow(hwnd),
      bounds(hwnd) {
        if (!IsWindow(hwnd) || IsIconic(hwnd)) return null
        const rect = { left: 0, top: 0, right: 0, bottom: 0 }
        if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, rectSize) !== 0) return null
        const width = rect.right - rect.left
        const height = rect.bottom - rect.top
        if (width <= 0 || height <= 0) return null
        return { x: rect.left, y: rect.top, width, height }
      },
      exeName(hwnd) {
        const pid = [0]
        GetWindowThreadProcessId(hwnd, pid)
        if (!pid[0]) return null
        const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid[0])
        if (!handle) return null
        try {
          const buffer = Buffer.alloc(1024 * 2)
          const size = [1024]
          if (!QueryFullProcessImageNameW(handle, 0, buffer, size)) return null
          return path.win32.basename(buffer.toString('utf16le', 0, size[0] * 2)).toLowerCase()
        } finally {
          CloseHandle(handle)
        }
      },
    }
  } catch {
    return null
  }
}
