'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clockRate } from '@/lib/beatmap'
import { OffsetPanel } from './offset-panel'

// tosu/gosumemory menu state while a map is being played.
const OSU_PLAYING = 2
import { SiteHeader } from '@/components/site-header'
import { StatusBadge, pingTone } from '@/components/status-badge'
import { useBridge } from '@/hooks/use-bridge'
import { useHostSession } from '@/hooks/use-host-session'
import type { Role, TapSlot } from '@/lib/protocol'
import { HostStage } from './host-stage'
import { RolePanel } from './role-panel'
import { BridgePanel } from './bridge-panel'
import { SessionPanel } from './session-panel'

const RELEASED = { k1: false, k2: false }

export function HostRoom() {
  const [guestRole, setGuestRole] = useState<Role>('tap')
  const [k1, setK1] = useState('z')
  const [k2, setK2] = useState('x')
  const [keys, setKeys] = useState(RELEASED)
  const aimRef = useRef<{ x: number; y: number } | null>(null)

  const bindings = useMemo(() => ({ k1, k2 }), [k1, k2])
  const sessionRef = useRef<ReturnType<typeof useHostSession> | null>(null)
  const playRef = useRef({ playing: false, rate: 1 })
  const bridge = useBridge(bindings, {
    onOsu: (osu) => {
      const playing = osu.source !== null && osu.state === OSU_PLAYING
      playRef.current = { playing, rate: clockRate(osu.mods) }
      sessionRef.current?.publishSync({ live: playing, mods: osu.mods })
    },
    onTime: (ms) => {
      sessionRef.current?.publishClock(ms, playRef.current.rate, playRef.current.playing)
    },
    onMap: (checksum, text) => sessionRef.current?.publishMap(checksum, text),
  })
  const { send } = bridge

  const onAim = useCallback(
    (x: number, y: number) => {
      aimRef.current = { x, y }
      send({ t: 'aim', x, y })
    },
    [send],
  )
  const onKey = useCallback(
    (k: TapSlot, down: boolean) => {
      setKeys((prev) => ({ ...prev, [k]: down }))
      send({ t: 'key', k, down })
    },
    [send],
  )
  const onRelease = useCallback(() => {
    setKeys(RELEASED)
    aimRef.current = null
    send({ t: 'release' })
  }, [send])

  const session = useHostSession(guestRole, { onAim, onKey, onRelease })
  useEffect(() => {
    sessionRef.current = session
  })

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <StatusBadge tone={bridge.status === 'connected' ? 'good' : 'idle'}>
            Bridge {bridge.status === 'connected' ? 'on' : 'off'}
          </StatusBadge>
          <StatusBadge tone={session.status === 'connected' ? pingTone(session.rtt) : 'idle'}>
            {session.status === 'connected'
              ? `Partner ${session.rtt !== null ? `${session.rtt} ms` : 'joined'}`
              : 'No partner'}
          </StatusBadge>
        </div>
      </SiteHeader>
      <main className="grid flex-1 gap-4 p-4 md:p-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <HostStage
          stream={session.stream}
          aimRef={aimRef}
          showAim={guestRole === 'aim' && session.status === 'connected'}
          keys={keys}
          bindings={bindings}
          guestRole={guestRole}
          partnerVideo={session.status === 'connected' ? (session.partner?.videoState ?? null) : null}
        />
        <aside className="flex flex-col gap-4" aria-label="Session setup">
          <RolePanel guestRole={guestRole} onChange={setGuestRole} k1={k1} k2={k2} onK1={setK1} onK2={setK2} />
          <BridgePanel status={bridge.status} screen={bridge.screen} onConnect={bridge.connect} onDisconnect={bridge.disconnect} />
          <SessionPanel session={session} bridgeReady={bridge.status === 'connected'} />
          <OffsetPanel partner={session.partner} osu={bridge.osu} guestRole={guestRole} />
        </aside>
      </main>
    </div>
  )
}
