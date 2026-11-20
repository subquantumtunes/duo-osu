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
  /** Width of the whole mania stage (columns, notes, and blackout) as a percentage of the skin's. */
  maniaStageScale: number
  /** Horizontal nudge of the mania stage, in osu!'s 480-tall playfield units. */
  maniaStageOffset: number
  /** Vertical thickness of mania notes as a percentage of the default. */
  maniaNoteThickness: number
  /** Hue for every mania note, or null to use the host skin's note colours. */
  maniaNoteHue: number | null
  /** Colour of the partner's mania lanes: hue in degrees, brightness 0 (black) to 100, opacity 0 to 100. */
  laneHue: number
  laneBrightness: number
  laneOpacity: number
}

export const DEFAULT_LANE_SETTINGS: LaneSettings = {
  maniaSpeed: 20,
  maniaConstant: false,
  taikoSpeed: 1,
  taikoConstant: false,
  maniaBlackout: 'off',
  streamBackground: false,
  maniaStageScale: 100,
  maniaStageOffset: 0,
  maniaNoteThickness: 100,
  maniaNoteHue: null,
  laneHue: 320,
  laneBrightness: 8,
  laneOpacity: 92,
}

export const STAGE_SCALE_MIN = 80
export const STAGE_SCALE_MAX = 140
export const STAGE_OFFSET_MAX = 40
export const NOTE_THICKNESS_MIN = 50
export const NOTE_THICKNESS_MAX = 400

export function noteHueColor(hue: number) {
  return `hsl(${hue} 90% 65%)`
}

/** The lane colour; brightness 0 is pure black whatever the hue. */
export function laneColor(hue: number, brightness: number, opacity = 100) {
  return `hsl(${hue} 30% ${brightness / 2}% / ${opacity / 100})`
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
