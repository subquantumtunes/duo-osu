'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { formatKey } from '@/lib/protocol'

export function KeyCapture({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (key: string) => void
}) {
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key !== 'Escape') onChange(e.key === ' ' ? ' ' : e.key.toLowerCase())
      setCapturing(false)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [capturing, onChange])

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Button
        type="button"
        variant="outline"
        className="min-w-20 font-mono"
        aria-label={`${label}: ${formatKey(value)}. Click to change`}
        onClick={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
      >
        {capturing ? 'Press a key…' : formatKey(value)}
      </Button>
    </div>
  )
}
