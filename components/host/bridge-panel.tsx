'use client'

import { useState } from 'react'
import { Check, Copy, Download, Plug, Unplug } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import type { BridgeStatus } from '@/hooks/use-bridge'
import { DEFAULT_BRIDGE_PORT } from '@/lib/protocol'
import { cn } from '@/lib/utils'
import { Panel } from './panel'

const BRIDGE_PATH = '/osu-coop-bridge.py'

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
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copyScript() {
    try {
      const res = await fetch(BRIDGE_PATH)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await navigator.clipboard.writeText(await res.text())
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 2000)
    } catch {
      setCopyState('failed')
    }
  }

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
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={BRIDGE_PATH}
          download="osu-coop-bridge.py"
          target="_blank"
          rel="noopener"
          onClick={(e) => {
            if (window.self !== window.top) {
              e.preventDefault()
              window.open(BRIDGE_PATH, '_blank', 'noopener')
            }
          }}
          className={cn(buttonVariants({ variant: 'outline' }), 'w-fit')}
        >
          <Download aria-hidden="true" />
          Download bridge
        </a>
        <Button type="button" variant="ghost" onClick={copyScript}>
          {copyState === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copyState === 'copied' ? 'Copied' : 'Copy script'}
        </Button>
      </div>
      {copyState === 'failed' && (
        <p role="alert" className="text-xs text-destructive">
          {"Couldn't copy here. Open "}
          <a href={BRIDGE_PATH} target="_blank" rel="noopener" className="underline underline-offset-2">
            the script
          </a>
          {' in a new tab and save it as osu-coop-bridge.py.'}
        </p>
      )}
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
