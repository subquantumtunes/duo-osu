'use client'

import { useCallback, useEffect, useState } from 'react'
import { defaultLaneKeys, laneCount, layoutId } from '@/lib/lanes'

const STORAGE_KEY = 'duosu:lane-keys'

type Saved = Record<string, string[]>

function readSaved(): Saved {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/**
 * The partner's key for every lane of the current taiko or mania layout. Starts from osu!'s
 * defaults and remembers changes per layout, so 4K and 7K keep their own keys.
 */
export function useLaneKeys(ruleset: number | null, keys: number | null) {
  const [saved, setSaved] = useState<Saved>({})

  useEffect(() => {
    setSaved(readSaved())
  }, [])

  const id = ruleset === null ? null : layoutId(ruleset, keys)
  const defaults = ruleset === null ? [] : defaultLaneKeys(ruleset, keys)
  const stored = id ? saved[id] : undefined
  const current = stored && stored.length === defaults.length ? stored : defaults

  const setLaneKey = useCallback(
    (lane: number, key: string) => {
      if (ruleset === null || !id) return
      setSaved((prev) => {
        const base = prev[id]?.length === laneCount(ruleset, keys) ? prev[id] : defaultLaneKeys(ruleset, keys)
        const nextLayout = base.map((k, i) => (i === lane ? key : k === key ? base[lane] : k))
        const next = { ...prev, [id]: nextLayout }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
        return next
      })
    },
    [ruleset, keys, id],
  )

  return [current, setLaneKey] as const
}
