'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { normalizeRoomCode } from '@/lib/protocol'

export function JoinForm() {
  const router = useRouter()
  const [code, setCode] = useState('')
  const valid = code.length >= 6

  return (
    <form
      className="mt-auto flex gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) router.push(`/play/${code}`)
      }}
    >
      <label htmlFor="room-code" className="sr-only">
        Room code
      </label>
      <input
        id="room-code"
        value={code}
        onChange={(e) => setCode(normalizeRoomCode(e.target.value))}
        placeholder="ROOM CODE"
        autoComplete="off"
        spellCheck={false}
        className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 font-mono tracking-widest uppercase outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <Button type="submit" size="lg" variant="secondary" className="px-4" disabled={!valid}>
        Join
      </Button>
    </form>
  )
}
