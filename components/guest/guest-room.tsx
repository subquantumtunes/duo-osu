'use client'

import { useEffect, useRef, useState } from 'react'
import { INJECT_LAG_MS } from '@/lib/timing'
import { Crosshair, Keyboard, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SiteHeader } from '@/components/site-header'
import { StatusBadge, pingTone } from '@/components/status-badge'
import { KeyCapture } from '@/components/key-capture'
import { useGuestSession } from '@/hooks/use-guest-session'
import { useCursorSettings } from '@/lib/cursor-settings'
import { GuestStage, type LaneControls } from './guest-stage'
import { useLaneKeys } from './use-lane-keys'
import { RULESET_MANIA, RULESET_TAIKO, isLaneRuleset, laneName } from '@/lib/lanes'
import { CursorSettingsPanel } from './cursor-settings'
import { LaneSettingsPanel } from './lane-settings'
import { useLaneSettings } from '@/lib/lane-settings'
import { useStandardSettings } from '@/lib/standard-settings'
import { StandardSettingsPanel } from './standard-settings'

export function GuestRoom({ code }: { code: string }) {
  const session = useGuestSession(code)
  const [k1, setK1] = useState('z')
  const [k2, setK2] = useState('x')
  const connected = session.status === 'connected'
  const [preferVideo, setPreferVideo] = useState(false)
  const leadMsRef = useRef(0)
  const [cursorStyle, updateCursorStyle] = useCursorSettings()
  const [laneSettings, updateLaneSettings] = useLaneSettings()
  const [standardSettings, updateStandardSettings] = useStandardSettings()
  // Older hosts don't say which map is live, so only check it when they do.
  const mapIsCurrent = session.sync?.map === undefined || session.sync.map === session.map?.checksum
  const ruleset = session.sync?.ruleset ?? null
  const laneMode = isLaneRuleset(ruleset) && session.sync?.lanes ? ruleset : null
  const [laneKeys, setLaneKey] = useLaneKeys(laneMode, session.sync?.keys ?? null)
  const laneControls: LaneControls | null =
    laneMode !== null && session.sync?.lanes
      ? { ruleset: laneMode, lanes: session.sync.lanes, keys: session.sync.lanes.map((l) => laneKeys[l] ?? '') }
      : null
  // Each mode needs its own notes; converted maps only have them for taiko.
  const mapFitsMode = (() => {
    const map = session.map
    if (!map) return false
    if (ruleset === RULESET_TAIKO) return map.drums.length > 0
    if (ruleset === RULESET_MANIA) return map.notes.length > 0 && map.keys === session.sync?.keys
    if (ruleset === 2) return false
    return map.objects.length > 0
  })()
  const playfieldReady = Boolean(session.map && session.sync?.live && mapIsCurrent && mapFitsMode)
  const usePlayfield = playfieldReady && !preferVideo
  const { setMode, transitRef } = session

  useEffect(() => {
    setMode(usePlayfield ? 'playfield' : 'video')
  }, [usePlayfield, setMode])

  useEffect(() => {
    let frame = 0
    const tick = () => {
      leadMsRef.current = transitRef.current + INJECT_LAG_MS
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [transitRef])

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
              {session.role === 'tap' && laneControls && (
                <div className="flex flex-wrap gap-3">
                  {laneControls.lanes.map((lane, i) => (
                    <KeyCapture
                      key={lane}
                      label={laneMode === RULESET_TAIKO ? laneName(RULESET_TAIKO, lane) : `Column ${lane + 1}`}
                      value={laneControls.keys[i]}
                      onChange={(key) => setLaneKey(lane, key)}
                    />
                  ))}
                </div>
              )}
              {session.role === 'tap' && !laneControls && (
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
              videoIssue={session.videoIssue}
              onRetryVideo={session.retryVideo}
              cursorStyle={cursorStyle}
              inputLive={Boolean(session.sync?.live)}
              laneControls={session.role === 'tap' ? laneControls : null}
              laneSettings={laneSettings}
              standardSettings={standardSettings}
              playfield={
                usePlayfield && session.map
                  ? {
                      map: session.map,
                      mods: session.sync?.mods ?? 0,
                      clockRef: session.clockRef,
                      leadMsRef,
                      skin: session.skin,
                      laneRuleset: laneMode ?? undefined,
                    }
                  : null
              }
            />
            <PlayfieldStatus
              ready={playfieldReady}
              loading={session.mapLoading}
              title={session.map?.title ?? null}
              preferVideo={preferVideo}
              onToggle={() => setPreferVideo((v) => !v)}
              videoLatency={session.videoLatency}
              audio={session.audio}
            />
            {session.role === 'tap' && laneMode !== null && (
              <LaneSettingsPanel ruleset={laneMode} settings={laneSettings} onChange={updateLaneSettings} />
            )}
            {laneMode === null && (
              <StandardSettingsPanel
                settings={standardSettings}
                onChange={updateStandardSettings}
                showAutopilot={session.role === 'tap'}
              />
            )}
            {(session.role === 'aim' || (laneMode === null && standardSettings.autopilot)) && (
              <CursorSettingsPanel
                settings={cursorStyle}
                onChange={updateCursorStyle}
                skinHasCursor={Boolean(session.skin?.cursor)}
              />
            )}
          </>
        ) : (
          <JoinCard
            code={code}
            status={session.status}
            error={session.error}
            kicked={session.kicked}
            onJoin={session.join}
          />
        )}
      </main>
    </div>
  )
}

function PlayfieldStatus({
  ready,
  loading,
  title,
  preferVideo,
  onToggle,
  videoLatency,
  audio,
}: {
  ready: boolean
  loading: boolean
  title: string | null
  preferVideo: boolean
  onToggle: () => void
  videoLatency: number | null
  audio: { bufferMs: number; latency: number; direct: boolean } | null
}) {
  const local = ready && !preferVideo
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">
          {local ? 'Local map playback' : loading ? 'Receiving map…' : 'Following the stream'}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {local
            ? `${title ?? 'Current map'} is drawn on your screen, timed ahead so your input lands on beat.`
            : ready
              ? 'Switch back to local playback to remove the stream delay.'
              : `Waiting for the host to start a map with tosu running.${videoLatency !== null ? ` Stream delay ${videoLatency} ms.` : ''}`}
        </span>
      </div>
      <dl className="flex gap-4 font-mono text-xs">
        <div className="flex flex-col">
          <dt className="text-muted-foreground">Audio delay</dt>
          <dd>{audio ? `~${audio.latency} ms` : '—'}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-muted-foreground">Audio buffer</dt>
          <dd>{audio ? `${audio.bufferMs} ms` : '—'}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-muted-foreground">Audio path</dt>
          <dd>{audio ? (audio.direct ? 'Direct' : 'WebRTC') : '—'}</dd>
        </div>
      </dl>
      {ready && (
        <Button variant="outline" size="sm" onClick={onToggle}>
          {preferVideo ? 'Use local playback' : 'Use stream only'}
        </Button>
      )}
    </div>
  )
}

function JoinCard({
  code,
  status,
  error,
  kicked,
  onJoin,
}: {
  code: string
  status: string
  error: string | null
  kicked: boolean
  onJoin: () => void
}) {
  return (
    <section className="mx-auto mt-10 flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-border bg-card p-8 text-center">
      <span className="text-sm text-muted-foreground">Joining room</span>
      <h1 className="font-mono text-4xl font-semibold tracking-[0.25em] text-primary">{code}</h1>
      <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
        {kicked
          ? 'The host freed up this room for another partner.'
          : status === 'ended'
          ? 'The session ended.'
          : 'You’ll see the host’s game and play your half of the controls. The host decides who aims and who taps.'}
      </p>
      {!kicked && (
        <Button size="lg" className="px-5" onClick={onJoin} disabled={status === 'connecting'}>
          {status === 'connecting' ? 'Connecting…' : status === 'ended' || status === 'error' ? 'Rejoin' : 'Join session'}
        </Button>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
