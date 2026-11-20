'use client'

import { Toggle } from './cursor-settings'

export function JudgementSettingsPanel({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <section
      aria-label="Judgements"
      className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm"
    >
      <Toggle label="Show judgements" checked={on} onChange={onChange} />
      <p className="text-xs text-muted-foreground">
        Draws the host&apos;s 100, 50, and miss judgements on your copy of the map. 300s aren&apos;t shown.
      </p>
    </section>
  )
}
