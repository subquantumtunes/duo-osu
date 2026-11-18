'use client'

import { useId } from 'react'
import { type CursorSettings, cursorColor } from '@/lib/cursor-settings'

const HUE_TRACK =
  'linear-gradient(to right, hsl(0 100% 60%), hsl(60 100% 60%), hsl(120 100% 60%), hsl(180 100% 60%), hsl(240 100% 60%), hsl(300 100% 60%), hsl(360 100% 60%))'

export function CursorSettingsPanel({
  settings,
  onChange,
  skinHasCursor,
}: {
  settings: CursorSettings
  onChange: (patch: Partial<CursorSettings>) => void
  skinHasCursor: boolean
}) {
  const id = useId()
  const color = cursorColor(settings.hue)
  const coloured = !(settings.useSkin && skinHasCursor)

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card px-4 py-3 text-sm"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={`${id}-title`} className="font-medium">
          Your cursor
        </h2>
        <span
          aria-hidden="true"
          className="size-5 rounded-full border-2"
          style={{ borderColor: color, backgroundColor: `hsl(${settings.hue} 100% 60% / 0.35)` }}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs">
            <label htmlFor={`${id}-hue`} className="text-muted-foreground">
              Color
            </label>
            {!coloured && <span className="text-muted-foreground">Trail only, skin cursor on</span>}
          </div>
          <input
            id={`${id}-hue`}
            type="range"
            min={0}
            max={360}
            step={1}
            value={settings.hue}
            onChange={(e) => onChange({ hue: Number(e.target.value) })}
            className="h-2 w-full cursor-pointer appearance-none rounded-full [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-transparent [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow"
            style={{ background: HUE_TRACK }}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs">
            <label htmlFor={`${id}-size`} className="text-muted-foreground">
              Size
            </label>
            <span className="font-mono text-foreground">{settings.size.toFixed(2)}x</span>
          </div>
          <input
            id={`${id}-size`}
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={settings.size}
            onChange={(e) => onChange({ size: Number(e.target.value) })}
            className="w-full cursor-pointer accent-primary"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Toggle label="Cursor trail" checked={settings.trail} onChange={(trail) => onChange({ trail })} />
        <Toggle
          label="Adaptive size"
          hint="Grows and shrinks with the map's circle size"
          checked={settings.adaptive}
          onChange={(adaptive) => onChange({ adaptive })}
        />
        {skinHasCursor && (
          <Toggle label="Use host's skin cursor" checked={settings.useSkin} onChange={(useSkin) => onChange({ useSkin })} />
        )}
      </div>
    </section>
  )
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 cursor-pointer accent-primary"
      />
      <span>{label}</span>
      {hint && <span className="text-muted-foreground">{hint}</span>}
    </label>
  )
}
