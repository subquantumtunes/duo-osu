'use client'

import { useState } from 'react'
import { Crosshair, Keyboard, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SiteHeader } from '@/components/site-header'
import { StatusBadge, pingTone } from '@/components/status-badge'
import { KeyCapture } from '@/components/key-capture'
import { useGuestSession } from '@/hooks/use-guest-session'
import { GuestStage } from './guest-stage'

export function GuestRoom({ code }: { code: string }) {
  const session = useGuestSession(code)
  const [k1, setK1] = useState('z')
  const [k2, setK2] = useState('x')
  const connected = session.status === 'connected'

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader>
        <div className="flex items-center gap-2">
          <span className="hidden font-mono text-xs text-muted-foreground sm:inline">Room {code}</span>
          <StatusBadge tone={connected ? pingTone(session.rtt) : 'idle'}>
            {connected ? (session.rtt !== null ? `${session.rtt} ms` : 'Connected') : 'Offline'}
          </StatusBadge>
          {connected && (
            <Button variant="ghost" size="sm" onClick={session.leave}>
              <LogOut aria-hidden="true" />
              Leave
            </Button>
          )}
        </div>
      </SiteHeader>
      <main className="flex flex-1 flex-col gap-4 p-4 md:p-6">
        {connected && session.role ? (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="flex items-center gap-3">
                {session.role === 'aim' ? (
                  <Crosshair className="size-6 text-accent" aria-hidden="true" />
                ) : (
                  <Keyboard className="size-6 text-primary" aria-hidden="true" />
                )}
                <div>
                  <h1 className="text-lg font-semibold">
                    {session.role === 'aim' ? 'You are aiming' : 'You are tapping'}
                  </h1>
                  <p className="text-sm text-muted-foreground">
                    {session.role === 'aim'
                      ? 'Move your mouse over the game. Your partner handles the keys.'
                      : 'Press your keys or click the game. Your partner handles the cursor.'}
                  </p>
                </div>
              </div>
              {session.role === 'tap' && (
                <div className="flex gap-3">
                  <KeyCapture label="Your K1" value={k1} onChange={setK1} />
                  <KeyCapture label="Your K2" value={k2} onChange={setK2} />
                </div>
              )}
            </div>
            <GuestStage
              stream={session.stream}
              role={session.role}
              bindings={{ k1, k2 }}
              sendAim={session.sendAim}
              sendKey={session.sendKey}
            />
          </>
        ) : (
          <JoinCard
            code={code}
            status={session.status}
            error={session.error}
            onJoin={session.join}
          />
        )}
      </main>
    </div>
  )
}

function JoinCard({
  code,
  status,
  error,
  onJoin,
}: {
  code: string
  status: string
  error: string | null
  onJoin: () => void
}) {
  return (
    <section className="mx-auto mt-10 flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-border bg-card p-8 text-center">
      <span className="text-sm text-muted-foreground">Joining room</span>
      <h1 className="font-mono text-4xl font-semibold tracking-[0.25em] text-primary">{code}</h1>
      <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
        {status === 'ended'
          ? 'The session ended.'
          : 'You’ll see the host’s game and play your half of the controls. The host decides who aims and who taps.'}
      </p>
      <Button size="lg" className="px-5" onClick={onJoin} disabled={status === 'connecting'}>
        {status === 'connecting' ? 'Connecting…' : status === 'ended' || status === 'error' ? 'Try again' : 'Join session'}
      </Button>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
