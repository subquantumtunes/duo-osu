import { cn } from '@/lib/utils'
import { formatKey } from '@/lib/protocol'

export function KeyLights({
  pressed,
  labels,
  className,
}: {
  pressed: { k1: boolean; k2: boolean }
  labels?: { k1: string; k2: string }
  className?: string
}) {
  return (
    <div className={cn('flex gap-2', className)} aria-label="Tap keys">
      {(['k1', 'k2'] as const).map((slot) => (
        <div
          key={slot}
          className={cn(
            'flex min-w-14 flex-col items-center rounded-lg border px-3 py-1.5 font-mono text-xs transition-colors duration-75',
            pressed[slot]
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-background/70 text-muted-foreground',
          )}
        >
          <span className="font-semibold">{slot.toUpperCase()}</span>
          {labels && <span className="text-[10px] opacity-80">{formatKey(labels[slot])}</span>}
          <span className="sr-only">{pressed[slot] ? 'pressed' : 'released'}</span>
        </div>
      ))}
    </div>
  )
}
