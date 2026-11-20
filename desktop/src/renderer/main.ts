import { clockRate } from '@/lib/beatmap'
import {
  type ManiaSplit,
  type TaikoSplit,
  MAX_LANES,
  RULESET_MANIA,
  RULESET_TAIKO,
  TAIKO_DEFAULT_KEYS,
  isLaneRuleset,
  laneCount,
  laneName,
  maniaDefaultKeys,
  partnerLanes,
} from '@/lib/lanes'
import { type Role, type TapSlot, laneOf, laneSlot } from '@/lib/protocol'
import { compensatingOffset, formatMs, videoInputLag } from '@/lib/timing'
import type { GameAudioStatus, GameClient, InputStatus, OsuStatus, ScreenSource } from '../shared/api'
import { keyLabel } from '../shared/keys'
import { HostSession, type Quality } from './session'

const OSU_PLAYING = 2
const SETTINGS_KEY = 'osu-coop-host-settings'

type Settings = {
  screenId: string | null
  /** Share the osu! window whenever it's open; off once the host picks a whole screen. */
  preferWindow: boolean
  guestRole: Role
  k1: string
  k2: string
  client: GameClient
  taikoKeys: string[]
  /** Column keys per mania key count; counts never edited use osu!'s defaults. */
  maniaKeys: Record<string, string[]>
  taikoSplit: TaikoSplit
  maniaSplit: ManiaSplit
} & Quality

const DEFAULTS: Settings = {
  screenId: null,
  preferWindow: true,
  guestRole: 'tap',
  k1: 'KeyZ',
  k2: 'KeyX',
  client: 'stable',
  taikoKeys: TAIKO_DEFAULT_KEYS,
  maniaKeys: {},
  taikoSplit: 'kat',
  maniaSplit: 'right',
  fps: 60,
  height: 720,
  codec: 'h264',
}

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

const settings = loadSettings()
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
$('build-id').textContent = `build ${__BUILD_ID__}`
const coop = window.coop

let screens: ScreenSource[] = []
let inputStatus: InputStatus = { native: false, reason: null }
let osu: OsuStatus = {
  source: null,
  client: settings.client,
  detected: null,
  state: null,
  mods: 0,
  offset: null,
  checksum: null,
  mapReady: false,
  ruleset: null,
  keys: null,
}
let keys: Partial<Record<TapSlot, boolean>> = {}
/** `k1`, `k2`, `taiko:<lane>` or `mania:<lane>` while a binding button waits for a key. */
let listening: string | null = null
/** The mania layout shown in the editor; follows the map once osu! reports one. */
let maniaCount = 4
let appliedLanes = ''
let playback = { playing: false, rate: 1 }

const quality = (): Quality => ({ fps: settings.fps, height: settings.height, codec: settings.codec })

const session = new HostSession(settings.guestRole, quality(), {
  onAim: (x, y) => coop.aim(x, y),
  onKey: (slot, down) => {
    coop.key(slot, down)
    keys = { ...keys, [slot]: down }
    renderKeys()
  },
  onRelease: () => {
    coop.release()
    keys = {}
    renderKeys()
  },
  onChange: () => render(),
})

function maniaKeysFor(count: number) {
  const saved = settings.maniaKeys[count]
  return saved?.length === count ? saved : maniaDefaultKeys(count)
}

function laneKeys(ruleset: number, count: number) {
  return ruleset === RULESET_TAIKO ? settings.taikoKeys : maniaKeysFor(count)
}

/** The lanes the partner plays in the current mode, or null outside taiko and mania. */
function currentLanes() {
  if (!isLaneRuleset(osu.ruleset)) return null
  if (osu.ruleset === RULESET_MANIA && !osu.keys) return null
  return partnerLanes(osu.ruleset, osu.keys, settings.taikoSplit, settings.maniaSplit)
}

function publishSync() {
  const playing = osu.source !== null && osu.state === OSU_PLAYING
  // Until the exact file is found the partner has no matching map, so it follows the stream
  // instead of drawing whatever map it received last.
  const lanes = currentLanes()
  session.publishSync({
    live: playing,
    mods: osu.mods,
    map: osu.mapReady ? osu.checksum : null,
    ruleset: osu.ruleset,
    keys: osu.ruleset === RULESET_MANIA ? osu.keys : null,
    lanes,
  })
}

async function applyLaneBindings() {
  if (!isLaneRuleset(osu.ruleset)) return
  const codes = laneKeys(osu.ruleset, laneCount(osu.ruleset, osu.keys))
  const signature = `${osu.ruleset}:${codes.join(',')}`
  if (signature === appliedLanes) return
  appliedLanes = signature
  // Lanes the partner isn't playing must be released, or a held column would stick.
  coop.release()
  keys = {}
  if (!(await coop.setLaneBindings(codes))) {
    session.error = 'One of the lane keys can’t be sent to osu!. Pick a letter, number or common key.'
    render()
  }
}

function applyOsu(next: OsuStatus) {
  const modeChanged = next.ruleset !== osu.ruleset || next.keys !== osu.keys
  const osuAppeared = osu.source === null && next.source !== null
  osu = next
  if (osuAppeared) maybeRefreshForWindow()
  if (modeChanged && next.ruleset === RULESET_MANIA && next.keys) maniaCount = next.keys
  if (modeChanged) void applyLaneBindings()
  if (next.detected && next.detected !== settings.client) {
    settings.client = next.detected
    saveSettings()
    coop.setClient(settings.client)
  }
  const playing = next.source !== null && next.state === OSU_PLAYING
  playback = { playing, rate: clockRate(next.mods) }
  publishSync()
  render()
}

let gameAudio: GameAudioStatus = { active: false, reason: null }
coop.onGameAudioStatus((status) => {
  gameAudio = status
  render()
})

function setChip(id: string, text: string, tone: 'good' | 'bad' | 'idle') {
  const chip = $(id)
  chip.textContent = text
  chip.dataset.tone = tone
}

let lightSignature = ''

function renderKeys() {
  const lanes = currentLanes()
  const slots: TapSlot[] = lanes ? lanes.map(laneSlot) : ['k1', 'k2']
  const box = $('keylights')
  const signature = `${osu.ruleset}:${slots.join(',')}`
  if (signature !== lightSignature) {
    lightSignature = signature
    box.replaceChildren(
      ...slots.map((slot) => {
        const light = document.createElement('span')
        light.className = 'keylight'
        light.dataset.slot = slot
        const lane = laneOf(slot)
        light.textContent = lane === null ? slot.toUpperCase() : osu.ruleset === RULESET_TAIKO ? laneName(RULESET_TAIKO, lane) : `${lane + 1}`
        return light
      }),
    )
  }
  for (const light of box.querySelectorAll<HTMLElement>('[data-slot]')) {
    light.toggleAttribute('data-on', Boolean(keys[light.dataset.slot as TapSlot]))
  }
}

function laneButtons(container: HTMLElement, prefix: 'taiko' | 'mania', codes: string[], partner: number[] | null) {
  container.replaceChildren(
    ...codes.map((code, lane) => {
      const id = `${prefix}:${lane}`
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'button key'
      button.dataset.lane = id
      const name = prefix === 'taiko' ? laneName(RULESET_TAIKO, lane) : `Column ${lane + 1}`
      button.textContent = listening === id ? '…' : keyLabel(code)
      button.title = name
      button.setAttribute('aria-label', `${name}: ${keyLabel(code)}${partner?.includes(lane) ? ', played by your partner' : ''}`)
      button.toggleAttribute('data-listening', listening === id)
      button.toggleAttribute('data-partner', Boolean(partner?.includes(lane)))
      return button
    }),
  )
}

function renderLanes() {
  const tap = settings.guestRole === 'tap'
  $('lanes').hidden = !tap
  if (!tap) return
  $<HTMLSelectElement>('taiko-split').value = settings.taikoSplit
  $<HTMLSelectElement>('mania-split').value = settings.maniaSplit
  $<HTMLSelectElement>('mania-count').value = String(maniaCount)
  laneButtons($('taiko-keys'), 'taiko', settings.taikoKeys, partnerLanes(RULESET_TAIKO, 4, settings.taikoSplit, settings.maniaSplit))
  laneButtons(
    $('mania-keys'),
    'mania',
    maniaKeysFor(maniaCount),
    partnerLanes(RULESET_MANIA, maniaCount, settings.taikoSplit, settings.maniaSplit),
  )
  const lanes = currentLanes()
  $('lane-hint').textContent =
    osu.ruleset === RULESET_TAIKO
      ? `osu! is on taiko. Your partner plays: ${lanes?.map((l) => laneName(RULESET_TAIKO, l)).join(', ')}. Highlighted keys are theirs; play the rest yourself.`
      : osu.ruleset === RULESET_MANIA
        ? osu.keys
          ? `osu! is on mania ${osu.keys}K. Your partner plays columns ${lanes?.map((l) => l + 1).join(', ')}. Play the rest yourself.`
          : 'osu! is on mania. Pick a map so tosu can report its key count.'
        : osu.ruleset === 2
          ? 'osu!catch isn’t supported yet. Your partner can still press K1 and K2.'
          : 'In taiko and mania your partner plays part of the drums or columns. Match these keys to your osu! bindings.'
}

function renderScreens() {
  const list = $('screens')
  list.replaceChildren(
    ...screens.map((screen) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'screen'
      button.setAttribute('role', 'radio')
      button.setAttribute('aria-checked', String(screen.id === settings.screenId))
      button.disabled = session.status !== 'idle' && session.status !== 'error'
      const img = document.createElement('img')
      img.src = screen.thumbnail
      img.alt = ''
      const text = document.createElement('span')
      const name = document.createElement('strong')
      name.textContent = screen.name + (screen.primary ? ' (main)' : '')
      const size = document.createElement('span')
      size.className = 'muted'
      size.textContent =
        screen.kind === 'window'
          ? `${screen.width} × ${screen.height} · recommended`
          : `${screen.width} × ${screen.height}`
      text.append(name, size)
      button.append(img, text)
      button.addEventListener('click', () => void selectScreen(screen.id, true))
      return button
    }),
  )
  if (screens.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'muted small'
    empty.textContent = 'Nothing to share found. Click Refresh.'
    list.append(empty)
  }
  const current = screens.find((s) => s.id === settings.screenId)
  const hasWindow = screens.some((s) => s.kind === 'window')
  $('capture-hint').textContent =
    current?.kind === 'window'
      ? 'Only the osu! window is streamed. Use borderless or windowed in osu!; exclusive fullscreen can stream a black picture.'
      : hasWindow
        ? 'Sharing a whole screen. Pick the osu! window for a sharper picture that keeps other windows private.'
        : 'Open osu! and click Refresh to share just its window.'
}

function renderTiming() {
  const box = $('timing')
  const parts: string[] = []
  const source = osu.source
  const lazer = osu.client === 'lazer'
  const offsetLabel = lazer ? 'Audio offset' : 'Universal Offset'
  const offsetWhere = lazer
    ? 'Settings → Audio → Offset Adjustment → Audio offset.'
    : 'Options → Gameplay → Universal Offset, or Alt + Plus/Minus in game.'
  if (!source) {
    parts.push(
      '<p class="muted">Run tosu next to osu! (stable or lazer). Your partner then gets the map drawn on their own screen, timed to your game, instead of reacting to the stream.</p>',
    )
  } else {
    const offset = osu.offset !== null ? `. Current ${offsetLabel}: <strong>${formatMs(osu.offset)}</strong>` : ''
    parts.push(`<p class="muted">Reading osu!${lazer ? ' lazer' : ''} through ${source}${offset}</p>`)
  }

  const partner = session.partner
  if (!partner) {
    parts.push('<p class="muted">Recommendations appear once your partner joins.</p>')
  } else if (settings.guestRole === 'aim') {
    parts.push(
      '<p class="muted">You are tapping, so osu! judges your own key presses. Keep your normal offset.</p>',
    )
  } else {
    const playfield = partner.mode === 'playfield'
    const lag = playfield ? 0 : videoInputLag(partner)
    const target = compensatingOffset(lag, osu.offset)
    const note = playfield
      ? 'Your partner’s screen already plays ahead by the ping, so no extra offset is needed.'
      : `Their taps arrive about ${Math.round(lag)} ms late.`
    parts.push(
      `<div class="offset"><span class="muted small">Set ${offsetLabel} in osu! to</span><strong>${formatMs(target)}</strong><span class="muted small">${note} ${offsetWhere}</span></div>`,
    )
  }
  box.innerHTML = parts.join('')
}

function render() {
  const active = session.status !== 'idle' && session.status !== 'error'

  setChip(
    'chip-input',
    inputStatus.native ? 'Native input ready' : 'Native input unavailable',
    inputStatus.native ? 'good' : 'bad',
  )
  setChip('chip-osu', osu.source ? `${osu.source} connected` : 'tosu not running', osu.source ? 'good' : 'idle')
  setChip(
    'chip-partner',
    session.status === 'connected' ? `Partner ${session.rtt !== null ? `${session.rtt} ms` : 'joined'}` : 'No partner',
    session.status === 'connected' ? 'good' : 'idle',
  )
  const sharing = session.stream !== null
  const audioOn = sharing && session.hasAudio && gameAudio.active
  setChip(
    'chip-audio',
    !sharing ? 'Game audio' : audioOn ? 'Game audio on' : 'No game audio',
    !sharing ? 'idle' : audioOn ? 'good' : 'bad',
  )
  $('audio-hint').textContent = !sharing
    ? ''
    : !session.hasAudio
      ? 'This build can’t create an audio track, so your partner won’t hear the game.'
      : audioOn
        ? 'Your partner hears osu! only. Discord and other apps stay off the stream.'
        : (gameAudio.reason ?? 'Starting game audio…')

  const video = $<HTMLVideoElement>('preview')
  if (video.srcObject !== session.stream) video.srcObject = session.stream
  video.toggleAttribute('data-live', session.stream !== null)
  $('preview-empty').hidden = session.stream !== null
  $('keylights').toggleAttribute('hidden', settings.guestRole !== 'tap')
  renderKeys()

  $('room-code').textContent = session.roomCode ?? '------'
  $<HTMLButtonElement>('copy-code').disabled = !session.roomCode
  $('kick-partner').hidden = session.status !== 'connected'
  $('room-hint').textContent =
    session.status === 'connected'
      ? 'Your partner is connected.'
      : session.roomCode && session.partnerExit === 'left'
        ? 'Your partner left. The room is still open for someone else.'
        : session.roomCode && session.partnerExit === 'lost'
          ? 'Lost connection to your partner. They can rejoin with the same code.'
          : session.roomCode && session.partnerExit === 'kicked'
            ? 'Partner removed. Share the code with someone else.'
            : session.roomCode
        ? 'Your partner opens the duosu site and enters this code.'
        : session.status === 'starting'
          ? 'Starting…'
          : 'Start hosting to get a code for your partner.'

  const enc = session.encoder
  $('stat-encoder').textContent = !enc
    ? '-'
    : enc.name
      ? `${enc.hardware === true ? 'GPU' : enc.hardware === false ? 'CPU' : ''} ${enc.name}`.trim()
      : enc.track !== 'live'
        ? `Capture ${enc.track}`
        : enc.link !== 'connected'
          ? `Video link ${enc.link}${enc.linkNote ? ` (${enc.linkNote})` : ''}`
          : 'No frames encoded'
  $('stat-encoder').title = enc?.name ?? enc?.linkNote ?? ''
  $('stat-encode').textContent = enc?.encodeMs != null ? `${enc.encodeMs.toFixed(1)} ms` : '-'
  $('stat-fps').textContent =
    enc?.fps != null
      ? `${Math.round(enc.fps)} fps${enc.height ? ` · ${enc.height}p` : ''}${enc.limitation && enc.limitation !== 'none' ? ` · ${enc.limitation}` : ''}`
      : enc?.captureFps != null
        ? `${Math.round(enc.captureFps)} fps captured, 0 sent`
        : '-'
  $('stat-ping').textContent = session.rtt !== null ? `${session.rtt} ms` : '-'
  $('stat-delay').textContent = session.partner?.video != null ? `${session.partner.video} ms` : '-'
  $('stat-audio').textContent = session.partner?.audio != null ? `${session.partner.audio} ms` : '-'
  $('stat-mode').textContent = session.partner ? (session.partner.mode === 'playfield' ? 'Local map' : 'Stream') : '-'

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-client]')) {
    button.setAttribute('aria-checked', String(button.dataset.client === settings.client))
  }
  const mismatch = osu.detected !== null && osu.detected !== settings.client
  const waitingForMap = osu.source !== null && osu.checksum !== null && !osu.mapReady
  $('client-hint').textContent = mismatch
    ? `tosu says osu! ${osu.detected} is running. Switch to ${osu.detected === 'lazer' ? 'Lazer' : 'Stable'} so your partner gets the map.`
    : waitingForMap
      ? 'Waiting for the beatmap file of the selected difficulty. Your partner follows the stream until it is found.'
      : settings.client === 'lazer'
      ? 'Your partner sees the duosu site’s own circles. Lazer skins can’t be read from outside the game.'
      : 'Your partner sees the circles from the skin you have selected in osu!.'
  $('client-hint').toggleAttribute('data-warn', mismatch)

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-role]')) {
    button.setAttribute('aria-checked', String(button.dataset.role === settings.guestRole))
  }
  $('role-hint').textContent =
    settings.guestRole === 'tap'
      ? 'You aim with your own mouse. Their key presses are typed into osu! on this PC.'
      : 'You tap on your own keyboard. Their cursor moves the mouse on the shared screen.'
  $('bindings').hidden = settings.guestRole !== 'tap' || isLaneRuleset(osu.ruleset)
  renderLanes()
  for (const slot of ['k1', 'k2'] as const) {
    const button = $(`bind-${slot}`)
    button.textContent = listening === slot ? 'Press a key…' : keyLabel(settings[slot])
    button.toggleAttribute('data-listening', listening === slot)
  }

  for (const id of ['quality-fps', 'quality-height', 'quality-codec']) $<HTMLSelectElement>(id).disabled = active

  const start = $<HTMLButtonElement>('start')
  start.textContent = active ? 'Stop hosting' : 'Start hosting'
  start.toggleAttribute('data-active', active)
  start.disabled = session.status === 'starting' || (!active && !settings.screenId)

  $('error').textContent =
    session.error ?? (!active && !settings.screenId ? 'Pick the osu! window or a screen to share first.' : '')

  renderScreens()
  renderTiming()
}

async function selectScreen(id: string, fromUser = false) {
  const ok = await coop.selectScreen(id)
  settings.screenId = ok ? id : null
  if (ok && fromUser) settings.preferWindow = screens.find((s) => s.id === id)?.kind === 'window'
  saveSettings()
  render()
}

let refreshing = false

async function refreshScreens() {
  if (refreshing) return
  refreshing = true
  try {
    screens = await coop.listScreens()
    const osuWindow = screens.find((s) => s.kind === 'window')
    const saved = screens.find((s) => s.id === settings.screenId)
    const keep =
      (settings.preferWindow ? osuWindow : undefined) ??
      saved ??
      screens.find((s) => s.primary) ??
      screens.find((s) => s.kind === 'screen') ??
      screens[0]
    if (keep) await selectScreen(keep.id)
    else render()
  } finally {
    refreshing = false
  }
}

const sharingIdle = () => session.status === 'idle' || session.status === 'error'

/** When osu! starts or restarts while not sharing, pick up its new window. */
function maybeRefreshForWindow() {
  if (!settings.preferWindow || !sharingIdle()) return
  if (screens.find((s) => s.id === settings.screenId)?.kind === 'window') return
  void refreshScreens()
}

async function applyBindings() {
  if (!(await coop.setBindings(settings.k1, settings.k2))) {
    session.error = 'That key can’t be sent to osu!. Pick a letter, number or common key.'
  }
}

function wireControls() {
  $('refresh-screens').addEventListener('click', () => void refreshScreens())

  $('start').addEventListener('click', () => {
    if (session.status === 'idle' || session.status === 'error') {
      session.setQuality(quality())
      void session.start()
    } else {
      session.stop()
    }
  })

  $('kick-partner').addEventListener('click', () => session.kick())

  $('copy-code').addEventListener('click', async () => {
    if (!session.roomCode) return
    const copied = await coop.copyText(session.roomCode).catch(() => false)
    const button = $('copy-code')
    button.textContent = copied ? 'Copied' : 'Copy failed'
    setTimeout(() => (button.textContent = 'Copy code'), 1500)
  })

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-client]')) {
    button.addEventListener('click', () => {
      settings.client = button.dataset.client === 'lazer' ? 'lazer' : 'stable'
      saveSettings()
      coop.setClient(settings.client)
      render()
    })
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-role]')) {
    button.addEventListener('click', () => {
      settings.guestRole = button.dataset.role === 'aim' ? 'aim' : 'tap'
      listening = null
      saveSettings()
      session.setGuestRole(settings.guestRole)
      render()
    })
  }

  for (const slot of ['k1', 'k2'] as const) {
    $(`bind-${slot}`).addEventListener('click', () => {
      listening = listening === slot ? null : slot
      render()
    })
  }

  for (const id of ['taiko-keys', 'mania-keys']) {
    $(id).addEventListener('click', (event) => {
      const lane = (event.target as HTMLElement).closest<HTMLElement>('[data-lane]')?.dataset.lane
      if (!lane) return
      listening = listening === lane ? null : lane
      render()
    })
  }

  const count = $<HTMLSelectElement>('mania-count')
  count.replaceChildren(
    ...Array.from({ length: MAX_LANES }, (_, i) => {
      const option = document.createElement('option')
      option.value = String(i + 1)
      option.textContent = `${i + 1}K`
      return option
    }),
  )
  count.addEventListener('change', () => {
    maniaCount = Number(count.value) || 4
    listening = null
    render()
  })

  const onSplit = () => {
    settings.taikoSplit = $<HTMLSelectElement>('taiko-split').value as TaikoSplit
    settings.maniaSplit = $<HTMLSelectElement>('mania-split').value as ManiaSplit
    saveSettings()
    coop.release()
    keys = {}
    publishSync()
    render()
  }
  $('taiko-split').addEventListener('change', onSplit)
  $('mania-split').addEventListener('change', onSplit)

  $('reset-lanes').addEventListener('click', () => {
    settings.taikoKeys = TAIKO_DEFAULT_KEYS
    settings.maniaKeys = {}
    listening = null
    saveSettings()
    session.error = null
    void applyLaneBindings().then(render)
    render()
  })

  window.addEventListener(
    'keydown',
    (event) => {
      if (!listening) return
      event.preventDefault()
      event.stopPropagation()
      if (event.code !== 'Escape') {
        session.error = null
        if (listening === 'k1' || listening === 'k2') {
          settings[listening] = event.code
          void applyBindings().then(render)
        } else {
          const [kind, index] = listening.split(':')
          const lane = Number(index)
          if (kind === 'taiko') {
            settings.taikoKeys = settings.taikoKeys.map((code, i) => (i === lane ? event.code : code))
          } else {
            const next = [...maniaKeysFor(maniaCount)]
            next[lane] = event.code
            settings.maniaKeys = { ...settings.maniaKeys, [maniaCount]: next }
          }
          void applyLaneBindings().then(render)
        }
        saveSettings()
      }
      listening = null
      render()
    },
    true,
  )

  const selects: [string, (value: string) => void][] = [
    ['quality-fps', (v) => (settings.fps = v === '120' ? 120 : 60)],
    ['quality-height', (v) => (settings.height = v === '1080' ? 1080 : 720)],
    ['quality-codec', (v) => (settings.codec = v === 'auto' ? 'auto' : 'h264')],
  ]
  for (const [id, apply] of selects) {
    const select = $<HTMLSelectElement>(id)
    select.value = String(settings[id.replace('quality-', '') as 'fps' | 'height' | 'codec'])
    select.addEventListener('change', () => {
      apply(select.value)
      saveSettings()
    })
  }
}

async function init() {
  wireControls()
  render()

  coop.onOsu(applyOsu)
  coop.onCaptureLost(() => {
    if (sharingIdle()) {
      void refreshScreens()
      return
    }
    session.error = 'The osu! window closed. Stop sharing, then start again to pick up the new window.'
    render()
  })
  coop.onTime((ms) => session.publishClock(ms, playback.rate, playback.playing))
  coop.onMap((map) => session.publishMap(map.checksum, map.text))
  coop.onSkin((skin) => session.publishSkin(skin))
  coop.setClient(settings.client)

  const [status, snapshot] = await Promise.all([coop.inputStatus(), coop.osuSnapshot()])
  inputStatus = status
  if (!status.native && status.reason) session.error = status.reason
  if (snapshot.map) session.publishMap(snapshot.map.checksum, snapshot.map.text)
  if (snapshot.skin) session.publishSkin(snapshot.skin)
  applyOsu(snapshot.status)

  await applyBindings()
  await applyLaneBindings()
  await refreshScreens()
}

void init()
