'use client'

import { useState } from 'react'
import { Download, Plug, Unplug } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import type { BridgeStatus } from '@/hooks/use-bridge'
import { DEFAULT_BRIDGE_PORT } from '@/lib/protocol'
import { cn } from '@/lib/utils'
import { Panel } from './panel'

const STATUS_TEXT: Record<BridgeStatus, string> = {
  disconnected: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  'bad-token': 'Wrong pairing code',
  unreachable: 'Bridge not running',
}

export function BridgePanel({
  status,
  screen,
  onConnect,
  onDisconnect,
}: {
  status: BridgeStatus
  screen: [number, number] | null
  onConnect: (token: string, port: number) => void
  onDisconnect: () => void
}) {
  const [token, setToken] = useState('')
  const connected = status === 'connected'

  return (
    <Panel step={2} title="Run the input bridge">
      <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
        <li>
          Install Python, then run <code className="rounded bg-secondary px-1 py-0.5 font-mono text-foreground">pip install websockets pynput</code>
        </li>
        <li>
          Run <code className="rounded bg-secondary px-1 py-0.5 font-mono text-foreground">python osu-coop-bridge.py</code> and
          paste the pairing code below.
        </li>
        <li>
          If your browser asks to access devices on your local network, allow it.
        </li>
      </ol>
      <a
        href="/osu-coop-bridge.py"
        download
        className={cn(buttonVariants({ variant: 'outline' }), 'w-fit')}
      >
        <Download aria-hidden="true" />
        Download bridge
      </a>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (connected) onDisconnect()
          else onConnect(token, DEFAULT_BRIDGE_PORT)
        }}
      >
        <label htmlFor="pair-code" className="sr-only">
          Pairing code
        </label>
        <input
          id="pair-code"
          value={token}
          onChange={(e) => setToken(e.target.value.toUpperCase())}
          placeholder="XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          disabled={connected}
          className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 font-mono text-sm tracking-widest outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
        />
        <Button type="submit" variant={connected ? 'outline' : 'secondary'} disabled={!connected && token.replace(/[^A-Z0-9]/g, '').length < 8}>
          {connected ? <Unplug aria-hidden="true" /> : <Plug aria-hidden="true" />}
          {connected ? 'Disconnect' : 'Pair'}
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <StatusBadge tone={connected ? 'good' : status === 'disconnected' || status === 'connecting' ? 'idle' : 'bad'}>
          {STATUS_TEXT[status]}
        </StatusBadge>
        {connected && screen && (
          <span className="font-mono text-xs text-muted-foreground">
            aim area {screen[0]}×{screen[1]}
          </span>
        )}
      </div>
    </Panel>
  )
}
