import { clockRate } from '@/lib/beatmap'
import type { Role, TapSlot } from '@/lib/protocol'
import { compensatingOffset, formatMs, videoInputLag } from '@/lib/timing'
import type { GameAudioStatus, GameClient, InputStatus, OsuStatus, ScreenSource } from '../shared/api'
import { keyLabel } from '../shared/keys'
import { HostSession, type Quality } from './session'

const OSU_PLAYING = 2
const SETTINGS_KEY = 'osu-coop-host-settings'

type Settings = { screenId: string | null; guestRole: Role; k1: string; k2: string; client: GameClient } & Quality

const DEFAULTS: Settings = {
  screenId: null,
  guestRole: 'tap',
  k1: 'KeyZ',
  k2: 'KeyX',
  client: 'stable',
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
let osu: OsuStatus = { source: null, client: settings.client, detected: null, state: null, mods: 0, offset: null }
let keys = { k1: false, k2: false }
let listening: TapSlot | null = null
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
    keys = { k1: false, k2: false }
    renderKeys()
  },
  onChange: () => render(),
})

function applyOsu(next: OsuStatus) {
  osu = next
  const playing = next.source !== null && next.state === OSU_PLAYING
  playback = { playing, rate: clockRate(next.mods) }
  session.publishSync({ live: playing, mods: next.mods })
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

function renderKeys() {
  $('light-k1').toggleAttribute('data-on', keys.k1)
  $('light-k2').toggleAttribute('data-on', keys.k2)
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
      size.textContent = `${screen.width} × ${screen.height}`
      text.append(name, size)
      button.append(img, text)
      button.addEventListener('click', () => void selectScreen(screen.id))
      return button
    }),
  )
  if (screens.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'muted small'
    empty.textContent = 'No screens found. Click Refresh screens.'
    list.append(empty)
  }
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
  $('preview').parentElement?.querySelector('.keylights')?.toggleAttribute('hidden', settings.guestRole !== 'tap')

  $('room-code').textContent = session.roomCode ?? '------'
  $<HTMLButtonElement>('copy-code').disabled = !session.roomCode
  $('room-hint').textContent =
    session.status === 'connected'
      ? 'Your partner is connected.'
      : session.roomCode
        ? 'Your partner opens the co-op site and enters this code.'
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
  $('stat-mode').textContent = session.partner ? (session.partner.mode === 'playfield' ? 'Local map' : 'Stream') : '-'

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-client]')) {
    button.setAttribute('aria-checked', String(button.dataset.client === settings.client))
  }
  const mismatch = osu.detected !== null && osu.detected !== settings.client
  $('client-hint').textContent = mismatch
    ? `tosu says osu! ${osu.detected} is running. Switch to ${osu.detected === 'lazer' ? 'Lazer' : 'Stable'} so your partner gets the map.`
    : settings.client === 'lazer'
      ? 'Your partner sees the co-op site’s own circles. Lazer skins can’t be read from outside the game.'
      : 'Your partner sees the circles from the skin you have selected in osu!.'
  $('client-hint').toggleAttribute('data-warn', mismatch)

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-role]')) {
    button.setAttribute('aria-checked', String(button.dataset.role === settings.guestRole))
  }
  $('role-hint').textContent =
    settings.guestRole === 'tap'
      ? 'You aim with your own mouse. Their key presses are typed into osu! on this PC.'
      : 'You tap on your own keyboard. Their cursor moves the mouse on the shared screen.'
  $('bindings').hidden = settings.guestRole !== 'tap'
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
    session.error ?? (!active && !settings.screenId ? 'Pick the screen osu! runs on first.' : '')

  renderScreens()
  renderTiming()
}

async function selectScreen(id: string) {
  const ok = await coop.selectScreen(id)
  settings.screenId = ok ? id : null
  saveSettings()
  render()
}

async function refreshScreens() {
  screens = await coop.listScreens()
  const keep = screens.find((s) => s.id === settings.screenId) ?? screens.find((s) => s.primary) ?? screens[0]
  if (keep) await selectScreen(keep.id)
  else render()
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

  $('copy-code').addEventListener('click', async () => {
    if (!session.roomCode) return
    await navigator.clipboard.writeText(session.roomCode)
    const button = $('copy-code')
    button.textContent = 'Copied'
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

  window.addEventListener(
    'keydown',
    (event) => {
      if (!listening) return
      event.preventDefault()
      event.stopPropagation()
      if (event.code !== 'Escape') {
        settings[listening] = event.code
        saveSettings()
        session.error = null
        void applyBindings().then(render)
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
  await refreshScreens()
}

void init()
