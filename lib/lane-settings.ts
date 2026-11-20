'use client'

import { useCallback, useEffect, useState } from 'react'

/** What to paint black over the stream in mania: nothing, the host's columns, or the whole stage. */
export type ManiaBlackout = 'off' | 'host' | 'all'

export type LaneSettings = {
  /** osu!mania scroll speed, 1 to 40, as in the game. */
  maniaSpeed: number
  /** Keep mania notes at one speed regardless of BPM and SV changes. */
  maniaConstant: boolean
  /** Multiplier on osu!'s taiko scroll speed; 1 is the game's speed. */
  taikoSpeed: number
  taikoConstant: boolean
  maniaBlackout: ManiaBlackout
  /** Keep the stream visible at full brightness behind the mania stage. */
  streamBackground: boolean
}

export const DEFAULT_LANE_SETTINGS: LaneSettings = {
  maniaSpeed: 20,
  maniaConstant: false,
  taikoSpeed: 1,
  taikoConstant: false,
  maniaBlackout: 'off',
  streamBackground: false,
}

export const MANIA_SPEED_MIN = 1
export const MANIA_SPEED_MAX = 40
/** osu!'s scroll time at speed 1, for its default hit position of 402. */
const MANIA_MAX_TIME_RANGE = 11485
const DEFAULT_HIT_POSITION = 402

/** How far a mania note moves per real millisecond, in osu!'s 480-tall playfield units. */
export function maniaUnitsPerMs(speed: number) {
  return (DEFAULT_HIT_POSITION * speed) / MANIA_MAX_TIME_RANGE
}

const STORAGE_KEY = 'duosu:lane-settings'

function load(): LaneSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULT_LANE_SETTINGS, ...(JSON.parse(raw) as Partial<LaneSettings>) } : DEFAULT_LANE_SETTINGS
  } catch {
    return DEFAULT_LANE_SETTINGS
  }
}

/** The partner's own taiko and mania settings, remembered on this device and independent of the host. */
export function useLaneSettings() {
  const [settings, setSettings] = useState<LaneSettings>(DEFAULT_LANE_SETTINGS)

  useEffect(() => {
    setSettings(load())
  }, [])

  const update = useCallback((patch: Partial<LaneSettings>) => {
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
