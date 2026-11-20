'use client'

import { useId } from 'react'
import {
  BLACKOUT_WIDEN_MAX,
  type LaneSettings,
  type ManiaBlackout,
  MANIA_SPEED_MAX,
  MANIA_SPEED_MIN,
  noteHueColor,
} from '@/lib/lane-settings'
import { RULESET_MANIA } from '@/lib/lanes'
import { cn } from '@/lib/utils'
import { THUMB, Toggle } from './cursor-settings'

const BLACKOUT_OPTIONS: { value: ManiaBlackout; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'host', label: "Host's columns" },
  { value: 'all', label: 'Whole stage' },
]

const HUE_GRADIENT = `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 359].map(noteHueColor).join(', ')})`

export function LaneSettingsPanel({
  ruleset,
  settings,
  onChange,
}: {
  ruleset: number
  settings: LaneSettings
  onChange: (patch: Partial<LaneSettings>) => void
}) {
  const id = useId()
  const mania = ruleset === RULESET_MANIA
  const min = mania ? MANIA_SPEED_MIN : 0.5
  const max = mania ? MANIA_SPEED_MAX : 2
  const value = mania ? settings.maniaSpeed : settings.taikoSpeed
  const percent = ((value - min) / (max - min)) * 100
  const widenPercent = (settings.blackoutWiden / BLACKOUT_WIDEN_MAX) * 100

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card px-4 py-3 text-sm"
    >
      <div className="flex flex-col gap-0.5">
        <h2 id={`${id}-title`} className="font-medium">
          Your {mania ? 'mania' : 'taiko'} settings
        </h2>
        <p className="text-xs text-muted-foreground">Only affects your screen. The host keeps their own scroll speed.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs">
            <label htmlFor={`${id}-speed`} className="text-muted-foreground">
              Scroll speed
            </label>
            <span className="font-mono text-foreground">{mania ? value : `${value.toFixed(2)}x`}</span>
          </div>
          <input
            id={`${id}-speed`}
            type="range"
            min={min}
            max={max}
            step={mania ? 1 : 0.05}
            value={value}
            onChange={(e) => {
              const next = Number(e.target.value)
              onChange(mania ? { maniaSpeed: next } : { taikoSpeed: next })
            }}
            className={`h-2 w-full cursor-pointer appearance-none rounded-full ${THUMB}`}
            style={{ background: `linear-gradient(to right, var(--primary) ${percent}%, var(--muted) ${percent}%)` }}
          />
          <p className="text-xs text-muted-foreground">
            {mania ? 'Same 1 to 40 scale as osu!mania.' : '1.00x is osu!taiko’s normal speed.'}
          </p>
        </div>

        {mania && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-xs text-muted-foreground">Black out stream (during a map)</legend>
            <div className="flex flex-wrap gap-1 rounded-lg border border-border p-1">
              {BLACKOUT_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    'flex-1 cursor-pointer rounded-md px-3 py-1.5 text-center text-xs font-medium transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring',
                    settings.maniaBlackout === option.value
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  <input
                    type="radio"
                    name={`${id}-blackout`}
                    value={option.value}
                    checked={settings.maniaBlackout === option.value}
                    onChange={() => onChange({ maniaBlackout: option.value })}
                    className="sr-only"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>

      {mania && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor={`${id}-widen`} className="text-muted-foreground">
                Widen blackout
              </label>
              <span className="font-mono text-foreground">
                {settings.blackoutWiden === 0 ? 'Off' : `+${settings.blackoutWiden}`}
              </span>
            </div>
            <input
              id={`${id}-widen`}
              type="range"
              min={0}
              max={BLACKOUT_WIDEN_MAX}
              step={1}
              value={settings.blackoutWiden}
              onChange={(e) => onChange({ blackoutWiden: Number(e.target.value) })}
              className={`h-2 w-full cursor-pointer appearance-none rounded-full ${THUMB}`}
              style={{
                background: `linear-gradient(to right, var(--primary) ${widenPercent}%, var(--muted) ${widenPercent}%)`,
              }}
            />
            <p className="text-xs text-muted-foreground">Grows each blacked-out column (or the whole stage) on both sides.</p>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor={`${id}-hue`} className="text-muted-foreground">
                Note colour
              </label>
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="size-3 rounded-full border border-border"
                  style={{ background: settings.maniaNoteHue == null ? 'transparent' : noteHueColor(settings.maniaNoteHue) }}
                />
                <span className="font-mono text-foreground">
                  {settings.maniaNoteHue == null ? 'Host skin' : `${settings.maniaNoteHue}°`}
                </span>
              </span>
            </div>
            <input
              id={`${id}-hue`}
              type="range"
              min={0}
              max={359}
              step={1}
              value={settings.maniaNoteHue ?? 0}
              aria-valuetext={settings.maniaNoteHue == null ? 'Host skin colours' : `Hue ${settings.maniaNoteHue} degrees`}
              onChange={(e) => onChange({ maniaNoteHue: Number(e.target.value) })}
              className={cn(
                `h-2 w-full cursor-pointer appearance-none rounded-full ${THUMB}`,
                settings.maniaNoteHue == null && 'opacity-60',
              )}
              style={{ background: HUE_GRADIENT }}
            />
            <button
              type="button"
              onClick={() => onChange({ maniaNoteHue: null })}
              disabled={settings.maniaNoteHue == null}
              className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
            >
              Use host skin colours
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Toggle
          label="Constant scroll speed"
          hint="Ignore BPM and SV changes"
          checked={mania ? settings.maniaConstant : settings.taikoConstant}
          onChange={(on) => onChange(mania ? { maniaConstant: on } : { taikoConstant: on })}
        />
        {mania && (
          <Toggle
            label="Show stream in background"
            hint="Keep the host's video bright around the stage"
            checked={settings.streamBackground}
            onChange={(streamBackground) => onChange({ streamBackground })}
          />
        )}
      </div>
    </section>
  )
}
