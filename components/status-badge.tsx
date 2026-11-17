import { cn } from '@/lib/utils'

const TONES = {
  good: 'bg-chart-3',
  warn: 'bg-chart-4',
  bad: 'bg-destructive',
  idle: 'bg-muted-foreground',
} as const

export function StatusBadge({ tone, children }: { tone: keyof typeof TONES; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/60 px-2.5 py-0.5 text-xs">
      <span aria-hidden="true" className={cn('size-1.5 rounded-full', TONES[tone])} />
      {children}
    </span>
  )
}

export function pingTone(rtt: number | null): keyof typeof TONES {
  if (rtt === null) return 'idle'
  if (rtt < 60) return 'good'
  if (rtt < 120) return 'warn'
  return 'bad'
}
