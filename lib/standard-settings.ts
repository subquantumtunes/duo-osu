'use client'

import { useCallback, useEffect, useState } from 'react'

export type StandardSettings = {
  /** While tapping, draw a cursor that follows the map so the rhythm is visible under the blackout. */
  autopilot: boolean
  /** 0..1, how opaque the stream playfield blackout is. */
  blackoutOpacity: number
}

export const DEFAULT_STANDARD: StandardSettings = { autopilot: true, blackoutOpacity: 1 }

const STORAGE_KEY = 'duosu:standard'

function load(): StandardSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULT_STANDARD, ...(JSON.parse(raw) as Partial<StandardSettings>) } : DEFAULT_STANDARD
  } catch {
    return DEFAULT_STANDARD
  }
}

/** The partner's osu!standard view options, remembered on this device. */
export function useStandardSettings() {
  const [settings, setSettings] = useState<StandardSettings>(DEFAULT_STANDARD)

  useEffect(() => {
    setSettings(load())
  }, [])

  const update = useCallback((patch: Partial<StandardSettings>) => {
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
