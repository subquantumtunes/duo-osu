'use client'

import { useState } from 'react'
import { Check, Copy, MonitorUp, Square, TriangleAlert, UserX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { useHostSession } from '@/hooks/use-host-session'
import { Panel } from './panel'

type Session = ReturnType<typeof useHostSession>

export function SessionPanel({ session, bridgeReady }: { session: Session; bridgeReady: boolean }) {
  const [copied, setCopied] = useState(false)
  const live = session.status === 'waiting' || session.status === 'connected'

  const copyInvite = async () => {
    if (!session.roomCode) return
    await navigator.clipboard.writeText(`${window.location.origin}/play/${session.roomCode}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Panel step={3} title="Share and invite">
      {!live ? (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Pick <span className="text-foreground">Entire screen</span> and tick{' '}
            <span className="text-foreground">Share system audio</span> so your partner can hear the music.
          </p>
          <Button size="lg" className="w-fit px-4" onClick={session.start} disabled={session.status === 'starting'}>
            <MonitorUp aria-hidden="true" />
            {session.status === 'starting' ? 'Starting…' : 'Start sharing'}
          </Button>
          {!bridgeReady && (
            <p className="text-xs text-muted-foreground">You can share first and pair the bridge afterwards.</p>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Room code</span>
            <span className="font-mono text-3xl font-semibold tracking-[0.25em] text-primary">
              {session.roomCode ?? '······'}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={copyInvite} disabled={!session.roomCode}>
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy invite link'}
            </Button>
            {session.status === 'connected' && (
              <Button variant="outline" onClick={session.kick}>
                <UserX aria-hidden="true" />
                Kick partner
              </Button>
            )}
            <Button variant="destructive" onClick={session.stop}>
              <Square aria-hidden="true" />
              Stop
            </Button>
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {session.status === 'connected'
              ? 'Partner connected — go play!'
              : session.partnerExit === 'left'
                ? 'Your partner left. The room is still open — share the code to invite someone else.'
                : session.partnerExit === 'lost'
                  ? 'Lost connection to your partner. They can rejoin with the same code.'
                  : session.partnerExit === 'kicked'
                    ? 'Partner removed. Share the code to invite someone else.'
                    : 'Waiting for your partner to join…'}
          </p>
        </>
      )}
      {live && session.surface && session.surface !== 'monitor' && (
        <Warning>You shared a window or tab. Share the entire screen so cursor positions line up.</Warning>
      )}
      {live && !session.hasAudio && <Warning>No audio is being shared — your partner won’t hear the music.</Warning>}
      {session.error && <Warning>{session.error}</Warning>}
    </Panel>
  )
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 rounded-lg bg-destructive/10 p-2.5 text-xs leading-relaxed text-destructive" role="status">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}
