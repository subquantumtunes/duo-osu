'use client'

import { Crosshair, Keyboard } from 'lucide-react'
import { KeyCapture } from '@/components/key-capture'
import { cn } from '@/lib/utils'
import type { Role } from '@/lib/protocol'
import { Panel } from './panel'

const OPTIONS: { guestRole: Role; you: string; partner: string; icon: typeof Crosshair }[] = [
  { guestRole: 'tap', you: 'You aim', partner: 'Partner taps', icon: Crosshair },
  { guestRole: 'aim', you: 'You tap', partner: 'Partner aims', icon: Keyboard },
]

export function RolePanel({
  guestRole,
  onChange,
  k1,
  k2,
  onK1,
  onK2,
}: {
  guestRole: Role
  onChange: (role: Role) => void
  k1: string
  k2: string
  onK1: (key: string) => void
  onK2: (key: string) => void
}) {
  return (
    <Panel step={1} title="Split the controls">
      <div role="radiogroup" aria-label="Who does what" className="grid grid-cols-2 gap-2">
        {OPTIONS.map((opt) => {
          const selected = opt.guestRole === guestRole
          const Icon = opt.icon
          return (
            <button
              key={opt.guestRole}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(opt.guestRole)}
              className={cn(
                'flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/60',
              )}
            >
              <Icon className={cn('size-4', selected ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
              <span className="text-sm font-medium">{opt.you}</span>
              <span className="text-xs text-muted-foreground">{opt.partner}</span>
            </button>
          )
        })}
      </div>
      {guestRole === 'tap' && (
        <div className="flex flex-col gap-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Match these to your osu! keybinds. The bridge presses them when your partner taps.
          </p>
          <div className="flex gap-3">
            <KeyCapture label="osu! K1" value={k1} onChange={onK1} />
            <KeyCapture label="osu! K2" value={k2} onChange={onK2} />
          </div>
        </div>
      )}
    </Panel>
  )
}
