'use client'

import { useId } from 'react'
import {
  JUDGEMENT_DURATION_MAX,
  JUDGEMENT_DURATION_MIN,
  JUDGEMENT_OPACITY_MAX,
  JUDGEMENT_OPACITY_MIN,
  JUDGEMENT_SIZE_MAX,
  JUDGEMENT_SIZE_MIN,
  type JudgementStyle,
} from '@/lib/judgements'
import { Toggle } from './cursor-settings'
import { RangeSetting } from './lane-settings'

export function JudgementSettingsPanel({
  style,
  onChange,
}: {
  style: JudgementStyle
  onChange: (patch: Partial<JudgementStyle>) => void
}) {
  const id = useId()
  return (
    <section
      aria-label="Judgements"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm"
    >
      <Toggle label="Show judgements" checked={style.on} onChange={(on) => onChange({ on })} />
      <p className="text-xs text-muted-foreground">
        Draws the host&apos;s 100, 50, and miss judgements on your copy of the map using the host&apos;s skin.
        300s aren&apos;t shown.
      </p>
      {style.on && (
        <>
          <RangeSetting
            id={`${id}-size`}
            label="Size"
            display={`${style.size}%`}
            min={JUDGEMENT_SIZE_MIN}
            max={JUDGEMENT_SIZE_MAX}
            value={style.size}
            onChange={(size) => onChange({ size })}
          />
          <RangeSetting
            id={`${id}-opacity`}
            label="Opacity"
            display={`${style.opacity}%`}
            min={JUDGEMENT_OPACITY_MIN}
            max={JUDGEMENT_OPACITY_MAX}
            value={style.opacity}
            onChange={(opacity) => onChange({ opacity })}
          />
          <RangeSetting
            id={`${id}-duration`}
            label="Duration"
            display={`${(style.duration / 1000).toFixed(2)}s`}
            min={JUDGEMENT_DURATION_MIN}
            max={JUDGEMENT_DURATION_MAX}
            value={style.duration}
            onChange={(duration) => onChange({ duration })}
          />
        </>
      )}
    </section>
  )
}
