'use client'

import { useState } from 'react'
import { Check, Copy, Download, ExternalLink, Plug, Unplug } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import type { BridgeStatus } from '@/hooks/use-bridge'
import { DEFAULT_BRIDGE_PORT } from '@/lib/protocol'
import { cn } from '@/lib/utils'
import { Panel } from './panel'

// Preview and branch deployments sit behind Vercel login, which PowerShell can't pass, so always
// serve the bridge from the public production domain.
const PUBLIC_ORIGIN = 'https://duo-osu.vercel.app'
const WINDOWS_BRIDGE_URL = `${PUBLIC_ORIGIN}/osu-coop-bridge.cmd`
const PYTHON_BRIDGE_PATH = '/osu-coop-bridge.py'
const RUN_COMMAND = `powershell -NoProfile -ExecutionPolicy Bypass -c "[Net.ServicePointManager]::SecurityProtocol='Tls12'; irm ${WINDOWS_BRIDGE_URL} | iex"`

const STATUS_TEXT: Record<BridgeStatus, string> = {
  disconnected: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  'bad-token': 'Wrong pairing code',
  unreachable: "Couldn't reach the bridge",
}

function UnreachableHelp() {
  const embedded = window.self !== window.top
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed">
      {embedded ? (
        <>
          <p className="text-foreground">
            This page is running inside an embedded preview, and browsers block embedded pages from connecting to
            programs on your computer. Open the host page in its own tab and pair from there.
          </p>
          <a
            href="/host"
            target="_blank"
            rel="noopener"
            className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'w-fit')}
          >
            <ExternalLink aria-hidden="true" />
            Open host page in a new tab
          </a>
        </>
      ) : (
        <ul className="flex list-disc flex-col gap-1 pl-4 text-muted-foreground">
          <li>
            Check the bridge window still says <span className="text-foreground">bridge is running</span> and that you
            copied the latest pairing code (it changes each time the bridge starts).
          </li>
          <li>
            If Chrome or Edge asked to access devices on your local network and you blocked it, click the icon at the
            left of the address bar, allow <span className="text-foreground">Local network access</span>, and reload.
          </li>
          <li>Safari blocks this connection. Use Chrome, Edge, or Firefox on the host PC.</li>
          <li>Run the bridge on the same computer as this browser.</li>
        </ul>
      )}
    </div>
  )
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
  const runCommand = RUN_COMMAND
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(runCommand)
      setCopyState('copied')
      setTimeout(() => setCopyState('idle'), 2000)
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <Panel step={2} title="Run the input bridge">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Runs on this PC (the one with osu!). Your partner doesn&apos;t need it. Nothing to install on Windows.
      </p>
      <ol className="flex list-decimal flex-col gap-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
        <li>
          Download the bridge and double-click it. If Windows says it protected your PC, click{' '}
          <span className="text-foreground">More info</span>, then <span className="text-foreground">Run anyway</span>.
        </li>
        <li>Paste the pairing code from the bridge window below.</li>
        <li>If your browser asks to access devices on your local network, allow it.</li>
      </ol>
      <a
        href={WINDOWS_BRIDGE_URL}
        target="_blank"
        rel="noopener"
        className={cn(buttonVariants({ variant: 'outline' }), 'w-fit')}
      >
        <Download aria-hidden="true" />
        Download bridge for Windows
      </a>
      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-muted-foreground">
          Or skip the download: press <kbd className="rounded border border-border px-1 font-mono text-foreground">Win</kbd>{' '}
          + <kbd className="rounded border border-border px-1 font-mono text-foreground">R</kbd>, paste this, and press
          Enter.
        </p>
        <div className="flex items-stretch gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-secondary px-2.5 py-1.5 font-mono text-xs text-foreground" title={runCommand}>
            {runCommand}
          </code>
          <Button type="button" variant="secondary" size="sm" onClick={copyCommand} className="h-auto">
            {copyState === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copyState === 'copied' ? 'Copied' : 'Copy'}
          </Button>
        </div>
        {copyState === 'failed' && (
          <p role="alert" className="text-xs text-destructive">
            {"Couldn't copy here. Select the command and copy it manually."}
          </p>
        )}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">Mac, Linux, or prefer Python?</summary>
        <p className="mt-1.5 leading-relaxed">
          Install Python, run{' '}
          <code className="rounded bg-secondary px-1 py-0.5 font-mono text-foreground">pip install websockets pynput</code>
          , then{' '}
          <a href={PYTHON_BRIDGE_PATH} download="osu-coop-bridge.py" className="text-foreground underline underline-offset-2">
            download the Python bridge
          </a>{' '}
          and run <code className="rounded bg-secondary px-1 py-0.5 font-mono text-foreground">python osu-coop-bridge.py</code>.
        </p>
      </details>
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
      {status === 'unreachable' && <UnreachableHelp />}
    </Panel>
  )
}
