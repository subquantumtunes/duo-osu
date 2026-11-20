'use client'

import { useId } from 'react'
import type { StandardSettings } from '@/lib/standard-settings'
import { THUMB, Toggle } from './cursor-settings'

export function StandardSettingsPanel({
  settings,
  onChange,
  showAutopilot,
}: {
  settings: StandardSettings
  onChange: (patch: Partial<StandardSettings>) => void
  showAutopilot: boolean
}) {
  const id = useId()
  const percent = Math.round(settings.blackoutOpacity * 100)

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card px-4 py-3 text-sm"
    >
      <h2 id={`${id}-title`} className="font-medium">
        Playfield
      </h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs">
            <label htmlFor={`${id}-blackout`} className="text-muted-foreground">
              Blackout opacity
            </label>
            <span className="font-mono text-foreground">{percent}%</span>
          </div>
          <input
            id={`${id}-blackout`}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.blackoutOpacity}
            onChange={(e) => onChange({ blackoutOpacity: Number(e.target.value) })}
            className={`h-2 w-full cursor-pointer appearance-none rounded-full ${THUMB}`}
            style={{
              background: `linear-gradient(to right, var(--primary) ${percent}%, var(--muted) ${percent}%)`,
            }}
          />
          <p className="text-xs text-muted-foreground">Applies while the stream playfield is blacked out.</p>
        </div>

        {showAutopilot && (
          <div className="flex flex-col gap-2">
            <Toggle
              label="Autopilot cursor"
              checked={settings.autopilot}
              onChange={(autopilot) => onChange({ autopilot })}
            />
            <p className="text-xs text-muted-foreground">
              Draws a cursor that follows the map so you can feel the rhythm with the stream blacked out. It
              uses your cursor look below.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
