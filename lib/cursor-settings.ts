'use client'

import { useCallback, useEffect, useState } from 'react'

export type CursorSettings = {
  /** 0..360 around the colour wheel. */
  hue: number
  /** Multiplier on the normal cursor size. */
  size: number
  trail: boolean
  /** Scale the cursor with the beatmap's circle size. */
  adaptive: boolean
  /** Draw the host's skin cursor instead of the coloured one, when the skin has one. */
  useSkin: boolean
}

export const DEFAULT_CURSOR: CursorSettings = { hue: 45, size: 1, trail: true, adaptive: false, useSkin: false }

export const cursorColor = (hue: number) => `hsl(${hue} 100% 60%)`

const STORAGE_KEY = 'dosu:cursor'

function load(): CursorSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULT_CURSOR, ...(JSON.parse(raw) as Partial<CursorSettings>) } : DEFAULT_CURSOR
  } catch {
    return DEFAULT_CURSOR
  }
}

/** The partner's cursor look, remembered on this device. */
export function useCursorSettings() {
  const [settings, setSettings] = useState<CursorSettings>(DEFAULT_CURSOR)

  useEffect(() => {
    setSettings(load())
  }, [])

  const update = useCallback((patch: Partial<CursorSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {}
      return next
    })
  }, [])

  return [settings, update] as const
}
