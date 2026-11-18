'use client'

import type { OsuStatus } from '@/hooks/use-bridge'
import type { Role } from '@/lib/protocol'
import { type PartnerStats, compensatingOffset, formatMs, videoInputLag } from '@/lib/timing'
import { Panel } from './panel'

export function OffsetPanel({
  partner,
  osu,
  guestRole,
}: {
  partner: PartnerStats | null
  osu: OsuStatus | null
  guestRole: Role
}) {
  const tosu = osu?.source ? (osu.source === 'tosu' ? 'tosu' : 'gosumemory') : null

  return (
    <Panel step={4} title="Timing and offset">
      {!tosu && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Run{' '}
          <a href="https://github.com/tosuapp/tosu/releases" target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
            tosu
          </a>{' '}
          next to osu! stable and the bridge. Your partner then gets the map drawn on their own screen, timed to
          your game, instead of reacting to the stream.
        </p>
      )}
      {tosu && (
        <p className="text-xs text-muted-foreground">
          Reading osu! through <span className="text-foreground">{tosu}</span>
          {osu?.offset !== null && osu?.offset !== undefined && (
            <>
              . Current Universal Offset: <span className="font-mono text-foreground">{formatMs(osu.offset)}</span>
            </>
          )}
        </p>
      )}
      {!partner ? (
        <p className="text-xs text-muted-foreground">Recommendations appear once your partner joins.</p>
      ) : (
        <Recommendation partner={partner} osu={osu} guestRole={guestRole} />
      )}
    </Panel>
  )
}

function Recommendation({ partner, osu, guestRole }: { partner: PartnerStats; osu: OsuStatus | null; guestRole: Role }) {
  const playfield = partner.mode === 'playfield'
  const lag = playfield ? 0 : videoInputLag(partner)
  const current = osu?.offset ?? null
  const target = compensatingOffset(lag, current)

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <Stat label="Ping" value={`${partner.rtt} ms`} />
        <Stat label="Partner sees" value={playfield ? 'Local map' : 'Stream'} />
        <Stat label="Stream delay" value={partner.video !== null ? `${partner.video} ms` : '—'} />
        <Stat label="Audio delay" value={partner.audio != null ? `${partner.audio} ms` : '—'} />
        <Stat label="Their input lands" value={playfield ? 'On time' : `${Math.round(lag)} ms late`} />
      </dl>
      {guestRole === 'aim' ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          You are tapping, so osu! judges your own key presses. Keep your normal offset. Cursor lag only shows up as
          slightly late aim.
        </p>
      ) : (
        <div className="flex flex-col gap-1 rounded-xl border border-primary/40 bg-primary/10 p-3">
          <span className="text-xs text-muted-foreground">Set Universal Offset in osu! to</span>
          <span className="font-mono text-2xl font-semibold text-primary">{formatMs(target)}</span>
          <span className="text-xs leading-relaxed text-muted-foreground">
            {playfield
              ? 'Your partner’s screen already plays ahead by the ping, so no extra offset is needed.'
              : current === null
                ? `Their taps arrive about ${Math.round(lag)} ms late. Subtract that from your current offset.`
                : `Their taps arrive about ${Math.round(lag)} ms late.`}{' '}
            Options → Gameplay → Universal Offset, or press Alt + Plus/Minus in game.
          </span>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-secondary/60 px-2.5 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-foreground">{value}</dd>
    </div>
  )
}
