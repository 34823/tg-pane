import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cache, CachedChat, History, Kind, Login, Message, Tab, Viewer } from '../types'

// Telegram in a pane. The data comes from the backend/ scripts, which drive a logged-in Telegram Web in a headless
// Chromium through its own internal API. Counters are read from the cache file the scripts write; the browser is
// touched only while the pane is open and in use. Nothing is sent but what the person typed; a private chat is
// marked read only when they reply or press "Mark read".

const PANE = 'telegram'
const ALL = '@all' // the backend's pseudo-folder: all chats
const POLL_MS = 60_000 // the open chat, while the pane is in use: rarely — Telegram bans for hammering
const LOGIN_POLL_MS = 3_000
const IDLE_MS = 10 * 60_000
const FLOOD_PAUSE_MS = 10 * 60_000 // Telegram answered FLOOD_WAIT ("too often") — no polling for this long
const RESTART_GAP_MS = 5 * 60_000 // the browser is restarted by the pane at most once in 5 minutes
const PAGE = 40
const NARROW = 64 // below this many columns: the list or the chat, not both

const T = {
  en: {
    private: 'Private', channels: 'Categories', refresh: 'Refresh', cache: 'cache', allChats: 'All chats',
    noCache: 'no counters yet — press «Refresh»', loading: 'loading…', marking: 'marking read…', sending: 'sending…',
    sent: 'sent', notSent: 'NOT sent', failed: 'failed', counts: 'counters', updating: 'updating counters…',
    flood: 'Telegram asks to slow down — pausing for 10 min', restarting: 'starting the Telegram browser…',
    paused: 'auto-refresh paused — press «Refresh»', pickChat: 'Pick a chat on the left. The other person sees «read» only after you reply or press «Mark read».',
    pickFirst: 'Pick a chat first', read: (n: number) => `Mark read (${n})`, summary: 'Summary', readAll: 'Mark all read',
    folders: '← Folders', chats: '← Chats', allRead: 'all read', unread: 'unread', older: '▲ older', newer: '▼ newer', theme: 'theme', openMedia: (k: string) => `▣ ${k} · open`, mediaKind: { photo: 'photo', image: 'image', video: 'video (preview)', file: 'file' } as Record<string, string>,
    picture: 'picture', mediaLoading: 'downloading the picture…', mediaFail: 'could not get the picture', nothingYet: 'No messages yet', pick: 'pick a chat',
    me: 'me', placeholder: 'message, Enter to send', send: 'send', terminalOnly: 'Writing — from the terminal',
    readOnly: 'channel — read only', asked: (f: string) => `Summary of «${f}» requested — the answer comes in the conversation`,
    markedAll: (n: string) => `«${n}»: all marked read`,
    qr: 'Log in: Telegram on your phone → Settings → Devices → Link Desktop Device, then scan this code.',
    password: (cmd: string) => `The account has a cloud password. Type it in a terminal (it is not shown here): ${cmd} login`,
    down: 'The Telegram browser is not running.', start: 'Start', starting: 'starting the browser…', webLoading: 'Telegram Web is loading…',
    qrElsewhere: (cmd: string) => `Log in from a terminal: ${cmd} login`,
    noPlaywright: (py: string) => `${py} has no Playwright: ${py} -m pip install playwright && ${py} -m playwright install chromium (or set «Python» in /config)`,
    digestFolder: (f: string, cmd: string) =>
      `Summarize my Telegram folder «${f}»: run \`${cmd}\` (it prints the unread posts of the folder's channels and groups ` +
      `and marks them read) and retell them by topic, most important first, 1–2 lines per topic; name the channels at the end.`,
    digestChat: (t: string, cmd: string) =>
      `Summarize the Telegram channel «${t}»: run \`${cmd}\` (it prints its unread posts, at least the last 10, and marks them read) ` +
      `and retell them, most important first, 1–2 lines per post or topic.`,
    digestPrivate: (f: string, cmd: string) =>
      `Summarize my unread private Telegram chats (${f}): run \`${cmd}\` (it prints their unread messages and does NOT ` +
      `mark them read — the people will not see «read») and retell them by chat, who wants what, most urgent first, 1–2 lines per chat.`,
    digestPerson: (t: string, cmd: string) =>
      `Summarize my Telegram chat with «${t}»: run \`${cmd}\` (it prints the unread messages, at least the last 10, and does NOT ` +
      `mark them read) and retell it: what they wrote, what they want from me, 1–3 lines.`,
    tzAsk: 'Your time zone? Message times are shown in it.', tzOther: 'or type a name like Europe/Berlin, Enter',
    tzBad: (z: string) => `«${z}» is not a time zone`,
  },
  ru: {
    private: 'Личные', channels: 'Категории', refresh: 'Обновить', cache: 'кэш', allChats: 'Все чаты',
    noCache: 'нет кэша счётчиков — нажми «Обновить»', loading: 'загружаю…', marking: 'помечаю прочитанным…', sending: 'отправляю…',
    sent: 'отправлено', notSent: 'НЕ отправлено', failed: 'ошибка', counts: 'счётчики', updating: 'обновляю счётчики…',
    flood: 'Telegram просит притормозить — пауза 10 мин', restarting: 'запускаю браузер Telegram…',
    paused: 'автообновление на паузе — нажми «Обновить»', pickChat: 'Выбери чат слева. Собеседник увидит «прочитано», только когда ответишь или нажмёшь «Прочитать».',
    pickFirst: 'Сначала выбери чат', read: (n: number) => `Прочитать (${n})`, summary: 'Сводка', readAll: 'Прочитать всё',
    folders: '← Папки', chats: '← Чаты', allRead: 'всё прочитано', unread: 'непрочит.', older: '▲ раньше', newer: '▼ позже', theme: 'тема', openMedia: (k: string) => `▣ ${k} · открыть`, mediaKind: { photo: 'фото', image: 'картинка', video: 'видео (превью)', file: 'файл' } as Record<string, string>,
    picture: 'картинка', mediaLoading: 'скачиваю картинку…', mediaFail: 'не удалось получить картинку', nothingYet: 'Сообщений пока нет', pick: 'выбери чат',
    me: 'я', placeholder: 'сообщение, Enter — отправить', send: 'отправить', terminalOnly: 'Писать — из терминала',
    readOnly: 'канал — только чтение', asked: (f: string) => `Сводка по «${f}» запрошена — ответ придёт в разговоре`,
    markedAll: (n: string) => `«${n}»: всё помечено прочитанным`,
    qr: 'Вход: Telegram на телефоне → Настройки → Устройства → Подключить устройство, и наведи камеру на код.',
    password: (cmd: string) => `У аккаунта облачный пароль. Введи его в терминале (здесь он был бы виден): ${cmd} login`,
    down: 'Браузер Telegram не запущен.', start: 'Запустить', starting: 'запускаю браузер…', webLoading: 'Telegram Web загружается…',
    qrElsewhere: (cmd: string) => `Войти — из терминала: ${cmd} login`,
    noPlaywright: (py: string) => `у ${py} нет Playwright: ${py} -m pip install playwright && ${py} -m playwright install chromium (или укажи «Python» в /config)`,
    digestFolder: (f: string, cmd: string) =>
      `Сводка по моей Telegram-папке «${f}»: запусти \`${cmd}\` (печатает непрочитанные посты каналов и групп папки ` +
      `и помечает их прочитанными) и перескажи по-русски по темам, главное сверху, 1–2 строки на тему; в конце — какие каналы были.`,
    digestChat: (t: string, cmd: string) =>
      `Сводка по Telegram-каналу «${t}»: запусти \`${cmd}\` (печатает непрочитанные посты, минимум 10 последних, и помечает прочитанными) ` +
      `и перескажи по-русски, главное сверху, 1–2 строки на пост или тему.`,
    digestPrivate: (f: string, cmd: string) =>
      `Сводка по моим непрочитанным личным чатам в Telegram (${f}): запусти \`${cmd}\` (печатает непрочитанные сообщения и НЕ ` +
      `помечает их прочитанными — собеседники не увидят «прочитано») и перескажи по-русски по чатам: кто что хочет, срочное сверху, 1–2 строки на чат.`,
    digestPerson: (t: string, cmd: string) =>
      `Сводка по моему Telegram-чату с «${t}»: запусти \`${cmd}\` (печатает непрочитанные, минимум 10 последних, и НЕ ` +
      `помечает прочитанными) и перескажи по-русски: что написали, что хотят от меня, 1–3 строки.`,
    tzAsk: 'Твой часовой пояс? В нём показывается время сообщений.', tzOther: 'или впиши название, например Europe/Berlin, Enter',
    tzBad: (z: string) => `«${z}» — не часовой пояс`,
  },
}
type Strings = (typeof T)['en']

const tab = atom({ plugin: 'tg-pane', key: 'tab' } as const, 'private' as Tab)
const cache = atom({ plugin: 'tg-pane', key: 'cache' } as const, null as Cache | null)
const selected = atom({ plugin: 'tg-pane', key: 'selected' } as const, null as string | null) // chat on «Private»
const channel = atom({ plugin: 'tg-pane', key: 'channel' } as const, null as string | null) // chat on «Channels»
const folder = atom({ plugin: 'tg-pane', key: 'folder' } as const, null as string | null) // open folder on «Channels»
const chat = atom({ plugin: 'tg-pane', key: 'chat' } as const, null as History | null)
const lift = atom({ plugin: 'tg-pane', key: 'lift' } as const, 0) // how many rows (lines) of the newest messages are scrolled out of view
const viewer = atom({ plugin: 'tg-pane', key: 'viewer' } as const, null as Viewer | null) // a picture open over the chat
const theme = atom({ plugin: 'tg-pane', key: 'theme' } as const, 0) // index into THEMES
const listTop = atom({ plugin: 'tg-pane', key: 'listTop' } as const, 0) // first shown row of the chat list
const login = atom({ plugin: 'tg-pane', key: 'login' } as const, null as Login | null) // not logged in: what to show
const note = atom({ plugin: 'tg-pane', key: 'note' } as const, '')
const draft = atom({ plugin: 'tg-pane', key: 'draft' } as const, 0)
const askZone = atom({ plugin: 'tg-pane', key: 'askZone' } as const, false) // no time zone known: ask first

// Live until the module reloads: is the pane open, when the person last did something, is a request running,
// was another load asked for meanwhile, does the chat wait to be marked read, the FLOOD_WAIT pause, the last restart.
let isOpen = false
let lastActive = 0
let isFetching = false
let fetchAgain = false
let readWanted = false
let floodUntil = 0
let restartedAt = -Infinity

// Where the person was (tab, chats, folder) — in $.store, so it outlives /clear (a new session, empty $.state)
// and a restart of Claude Code. The pane's own chat history is loaded again.
type Place = { tab: Tab; selected: string | null; channel: string | null; folder: string | null }
let placeRestored = false
let wasOpen = false

async function remember($: EngineInterface) {
  const place: Place = { tab: await read($, tab), selected: await read($, selected), channel: await read($, channel), folder: await read($, folder) }
  await $.store.set('place', place)
}

async function restorePlace($: EngineInterface) {
  placeRestored = true
  const th = (await $.store.get('theme')) as number | undefined
  if (typeof th === 'number') await update($, theme, () => th)
  const p = (await $.store.get('place')) as Place | undefined
  if (!p) return
  await update($, tab, () => p.tab)
  await update($, selected, () => p.selected)
  await update($, channel, () => p.channel)
  await update($, folder, () => p.folder)
}

async function afterClear($: EngineInterface) {
  if (!wasOpen) return
  wasOpen = false
  await restorePlace($)
  await loadCache($)
  if (!(await $.ui.panes()).some(p => p.id === PANE)) await $.ui.open({ id: PANE, title: 'Telegram' })
  if (await currentPeer($)) await fetchChat($)
}

const isPrivateKind = (c: CachedChat) => (c.kind ? ['user', 'bot', 'self'].includes(c.kind) : !c.id.startsWith('-'))
const unreadFirst = (a: CachedChat, b: CachedChat) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0)
const sum = (chats: CachedChat[]) => chats.reduce((s, c) => s + c.unread, 0)

// Colour schemes the person flips through with the button in the header: the accent (borders, own messages, the
// selected tab) and a quiet tone for frames. Raw hex, not the terminal theme's keys, so they look the same everywhere.
const THEMES = [
  { name: 'cyan', accent: '#4fc3d9', frame: '#2f6f7a' },
  { name: 'violet', accent: '#a78bfa', frame: '#5b4b99' },
  { name: 'green', accent: '#4ade80', frame: '#2f7a4d' },
  { name: 'amber', accent: '#fbbf24', frame: '#8a6a14' },
  { name: 'rose', accent: '#fb7185', frame: '#8f3a49' },
]

// A message cut into lines of at most `width` cells: paragraphs kept, words not split unless longer than a line.
export function wrapLines(text: string, width: number) {
  const w = Math.max(4, width)
  const out: string[] = []
  for (const para of text.replace(/\r/g, '').split('\n')) {
    let line = '', used = 0
    const push = () => { out.push(line); line = ''; used = 0 }
    for (const word of para.split(/ +/)) {
      const n = [...word].reduce((s, ch) => s + cells(ch), 0)
      if (used && used + 1 + n <= w) { line += ` ${word}`; used += 1 + n; continue }
      if (used) push()
      if (n <= w) { line = word; used = n; continue }
      for (const ch of word) { // a word longer than a line
        const c = cells(ch)
        if (used + c > w) push()
        line += ch; used += c
      }
    }
    push()
  }
  while (out.length > 1 && out[out.length - 1] === '') out.pop()
  return out
}

type Row = { key: string; text: string; time?: string; out?: boolean; isDate?: boolean; media?: { mid: number; kind: string } }

// Every message as rows (one per line, whole text, nothing cut), with a date row where the day changes and a row
// with the «open» button under a picture. `me` null — no direction (a channel); in a group the sender's name leads.
export function layoutMessages(messages: Message[], width: number, openLabel: (kind: string) => string = k => k, isGroup = false) {
  const out: Row[] = []
  messages.forEach((m, i) => {
    if (m.date && m.date !== messages[i - 1]?.date) out.push({ key: `d${m.mid}`, text: m.date, isDate: true })
    const body = m.text.replace(/^\[media\] ?/, '')
    const who = isGroup && !m.out && m.from ? `${m.from}: ` : ''
    const lines = wrapLines(`${who}${body}`, width)
    lines.forEach((text, j) => out.push({ key: `m${m.mid}-${j}`, text, time: j === 0 ? m.time : undefined, out: m.out }))
    if (m.media && m.media !== 'file') out.push({ key: `o${m.mid}`, text: openLabel(m.media), out: m.out, media: { mid: m.mid, kind: m.media } })
  })
  return out
}

// A Telegram QR code as terminal cells: two modules per cell (▀, top in the foreground), black on white, quiet zone.
export function qrCells(qr: string[]) {
  const n = qr.length + 4
  const dark = (i: number, j: number) => qr[i - 2]?.[j - 2] === '1'
  const height = Math.ceil(n / 2)
  const words = new Uint32Array(n * height * 3)
  for (let r = 0; r < height; r++)
    for (let j = 0; j < n; j++) {
      const at = (r * n + j) * 3
      words[at] = 0x2580
      words[at + 1] = dark(2 * r, j) ? 0x000000 : 0xffffff
      words[at + 2] = dark(2 * r + 1, j) ? 0x000000 : 0xffffff
    }
  return { columns: n, rows: height, cells: new Uint8Array(words.buffer).toBase64() }
}

type Options = { python?: string; dataDir?: string; privateFolder?: string; language?: string; autoReadChannels?: boolean; timezone?: string }

// Set by register (a change of options reloads the module): the options, the strings, the backend's environment, the cache file.
let opt: Options = {}
let t: Strings = T.en
const env: Record<string, string> = {}
let cachePath = ''
let zoneName = '' // the time zone in use: the option, the one picked in the pane, or the system's (if not a server's UTC)

const ZONES = ['Europe/Moscow', 'Europe/Kyiv', 'Europe/Minsk', 'Asia/Almaty', 'Europe/Berlin', 'Europe/London', 'America/New_York', 'UTC']
const isZone = (z: string) => {
  try { new Intl.DateTimeFormat('en', { timeZone: z }); return true } catch { return false }
}
function systemZone() {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone
    return z && !/^(UTC|Etc\/.*|GMT)$/.test(z) ? z : '' // UTC is usually a server's, not the person's
  } catch { return '' }
}

function backend($: EngineInterface) {
  return `${$.plugin.root}/backend`
}
function command($: EngineInterface, script: string) {
  return `${Object.entries(env).map(([k, v]) => `${k}='${v}' `).join('')}${opt.python || 'python3'} ${backend($)}/${script}`
}

async function setup($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  const data = (opt.dataDir || '').replace(/^~(?=\/|$)/, home)
  if (data) env.TG_PANE_DATA = data
  zoneName = opt.timezone || ((await $.store.get('timezone')) as string | undefined) || systemZone()
  if (zoneName) env.TG_PANE_TZ = zoneName
  if (opt.privateFolder) env.TG_PANE_PRIVATE = opt.privateFolder
  return `${data || `${home}/.local/share/tg-pane`}/tg-counts.json`
}

const hhmm = (sec?: number) => {
  if (!sec) return '—'
  return new Date(sec * 1000).toLocaleTimeString(opt.language === 'ru' ? 'ru-RU' : 'en-GB',
    { hour: '2-digit', minute: '2-digit', ...(zoneName ? { timeZone: zoneName } : {}) })
}

async function setZone($: EngineInterface, z: string) {
  z = z.trim()
  if (!isZone(z)) return void $.ui.toast(t.tzBad(z))
  zoneName = env.TG_PANE_TZ = z
  await $.store.set('timezone', z)
  await update($, askZone, () => false)
  await refresh($) // times in the cache were written in the old zone
}

async function loadCache($: EngineInterface) {
  try {
    const parsed = JSON.parse(await $.fs.read(cachePath)) as Cache
    await update($, cache, () => parsed)
  } catch {
    await update($, note, () => t.noCache)
  }
}

async function run($: EngineInterface, script: string, args: string[], timeoutMs = 120_000, stdin?: string) {
  return $.process.run([opt.python || 'python3', `${backend($)}/${script}`, ...args], { cwd: backend($), env, timeoutMs, stdin })
}

// What the pane shows instead of chats while Telegram Web is not logged in (null — logged in).
async function checkLogin($: EngineInterface) {
  const r = await run($, 'tgbrowser.py', ['status'], 60_000)
  let s: Login = { state: 'down' }
  try { s = JSON.parse(r.stdout) as Login } catch { /* the browser did not answer: show «Start» */ }
  const was = await read($, login)
  await update($, login, () => (s.state === 'ok' ? null : s))
  if (s.state === 'ok' && was) await refresh($) // just logged in
}

async function startBrowser($: EngineInterface) {
  lastActive = await $.clock.now()
  await update($, note, () => t.starting)
  const r = await run($, 'tgbrowser.py', ['start'], 60_000)
  await update($, note, () => (r.exitCode === 0 ? '' : `${t.failed}: ${r.stderr.trim().slice(-140)}`))
  await checkLogin($)
}

// A script failed: pause on FLOOD_WAIT, restart a browser that does not answer, the login screen, else the error.
async function failed($: EngineInterface, r: { exitCode: number; stderr: string }, what: string) {
  const err = r.stderr.trim()
  if (r.exitCode === 75) {
    floodUntil = (await $.clock.now()) + FLOOD_PAUSE_MS
    return void (await update($, note, () => t.flood))
  }
  if (r.exitCode === 77) return void (await checkLogin($))
  if (r.exitCode === 76) {
    if ((await $.clock.now()) - restartedAt <= RESTART_GAP_MS) return void (await checkLogin($))
    restartedAt = await $.clock.now()
    await update($, note, () => t.restarting)
    await run($, 'tgbrowser.py', ['start'], 60_000)
    return void (await checkLogin($)) // logged out — the QR code right away
  }
  if (err.includes("No module named 'playwright'")) return void (await update($, note, () => t.noPlaywright(opt.python || 'python3')))
  await update($, note, () => `${what}: ${err.slice(-140)}`)
}

async function currentPeer($: EngineInterface) {
  return (await read($, tab)) === 'private' ? read($, selected) : read($, channel)
}

// History of the open chat (through the API, no «read» unless asked). Asked again meanwhile — load again after.
// Older messages loaded with «▲» are kept.
async function fetchChat($: EngineInterface) {
  if (isFetching) return void (fetchAgain = true)
  isFetching = true
  try {
    do {
      fetchAgain = false
      const peer = await currentPeer($)
      if (!peer) return
      const andRead = readWanted
      readWanted = false
      const r = await run($, 'tgchat.py', andRead ? [peer, String(PAGE), '--read'] : [peer, String(PAGE)])
      if (andRead) await loadCache($) // tgchat.py --read zeroed this chat's counter in the cache
      if ((await currentPeer($)) !== peer) continue // another chat was picked meanwhile — load that one
      if (r.exitCode !== 0) return void (await failed($, r, t.failed))
      const fresh = JSON.parse(r.stdout) as History
      await update($, chat, old => {
        if (old?.peer !== peer || !fresh.messages.length) return fresh
        const first = fresh.messages[0]!.mid
        return { ...fresh, messages: [...old.messages.filter(m => m.mid < first), ...fresh.messages] }
      })
      await update($, note, () => '')
    } while (fetchAgain)
  } finally {
    isFetching = false
  }
}

async function loadOlder($: EngineInterface) {
  const h = await read($, chat)
  const peer = await currentPeer($)
  if (!h || h.peer !== peer || !h.messages.length || isFetching) return
  isFetching = true
  try {
    const r = await run($, 'tgchat.py', [peer!, String(PAGE), '--before', String(h.messages[0]!.mid)])
    if (r.exitCode !== 0) return void (await failed($, r, t.failed))
    const older = (JSON.parse(r.stdout) as History).messages
    await update($, chat, old => (old?.peer === peer ? { ...old, messages: [...older.filter(m => m.mid < old.messages[0]!.mid), ...old.messages] } : old))
  } finally {
    isFetching = false
  }
  if (fetchAgain) await fetchChat($) // a chat was picked while older messages loaded
}

// What the last drawing showed, for the wheel and the keys: all rows of the open chat, the rows that fit, the left column.
const view = { total: 0, fit: 0, leftWidth: 0, listLen: 0, listFit: 0 }

// Moves the open chat's window by `step` rows (positive — toward older), at once; older messages load in the
// background when the top is near, the view stays where it is.
async function scroll($: EngineInterface, step: number) {
  lastActive = await $.clock.now()
  const now = await read($, lift)
  const max = Math.max(0, view.total - view.fit)
  const to = Math.max(0, Math.min(max, now + step))
  if (to !== now) await update($, lift, () => to)
  if (step > 0 && max - to < 6) void loadOlder($)
}

async function setTheme($: EngineInterface, i?: number) {
  const next = (i ?? (await read($, theme)) + 1) % THEMES.length
  await update($, theme, () => next)
  await $.store.set('theme', next)
}

// A picture of a message: downloaded on request, turned into cells and drawn over the chat inside the pane.
async function openMedia($: EngineInterface, mid: number, cols: number, rows: number) {
  lastActive = await $.clock.now()
  const peer = await currentPeer($)
  if (!peer) return
  await update($, note, () => t.mediaLoading)
  const r = await run($, 'tgmedia.py', [peer, String(mid)], 120_000)
  if (r.exitCode !== 0) return void (await failed($, r, t.mediaFail))
  const file = r.stdout.trim().split('\n').pop() ?? ''
  const c = await run($, 'tgcells.py', [file, String(cols), String(rows)], 60_000)
  if (c.exitCode !== 0) return void (await update($, note, () => `${t.mediaFail}: ${c.stderr.trim().slice(-100)}`))
  await update($, viewer, () => JSON.parse(c.stdout) as Viewer)
  await update($, note, () => '')
}

async function openChat($: EngineInterface, peer: string, andRead = false) {
  lastActive = await $.clock.now()
  readWanted = andRead
  if ((await read($, tab)) === 'private') await update($, selected, () => peer)
  else await update($, channel, () => peer)
  await update($, chat, () => null)
  await update($, lift, () => 0)
  await update($, note, () => t.loading)
  await remember($)
  await fetchChat($)
}

async function closeChat($: EngineInterface) {
  if ((await read($, tab)) === 'private') await update($, selected, () => null)
  else await update($, channel, () => null)
  await update($, chat, () => null)
  await remember($)
}

async function markRead($: EngineInterface) {
  lastActive = await $.clock.now()
  await update($, note, () => t.marking)
  readWanted = true
  await fetchChat($)
}

async function send($: EngineInterface, text: string) {
  const peer = await currentPeer($)
  if (!text.trim()) return
  if (!peer) return void $.ui.toast(t.pickFirst)
  lastActive = await $.clock.now()
  await update($, note, () => t.sending)
  const r = await run($, 'tgmsg.py', ['--peer', peer, text], 300_000)
  if (r.exitCode !== 0) return void (await failed($, r, t.notSent))
  await update($, draft, n => n + 1) // a new, empty input field
  await update($, lift, () => 0)
  await update($, note, () => t.sent)
  await loadCache($) // replied = the chat is read, tgmsg zeroed its counter
  await fetchChat($)
}

async function refresh($: EngineInterface) {
  lastActive = await $.clock.now()
  await update($, note, () => t.updating)
  const r = await run($, 'tgcache.py', [])
  await loadCache($)
  if (r.exitCode !== 0) return void (await failed($, r, t.failed))
  await update($, login, () => null)
  await update($, note, () => '')
  if (await currentPeer($)) await fetchChat($)
}

// Counters, quietly: when the pane opens and once a minute while it is open and in use. No server-side timer.
async function updateCounts($: EngineInterface) {
  const now = await $.clock.now()
  if (now < floodUntil || now - lastActive > IDLE_MS || (await read($, login))) return
  const r = await run($, 'tgcache.py', [])
  if (r.exitCode !== 0) return void (await failed($, r, t.counts))
  await loadCache($)
}

async function switchTab($: EngineInterface, to: Tab) {
  lastActive = await $.clock.now()
  await update($, tab, () => to)
  await update($, chat, () => null)
  await update($, lift, () => 0)
  await update($, listTop, () => 0)
  await update($, note, () => '')
  await remember($)
  if (await currentPeer($)) await fetchChat($)
}

async function openFolder($: EngineInterface, f: string | null) {
  lastActive = await $.clock.now()
  await update($, folder, () => f)
  await update($, channel, () => null)
  await update($, chat, () => null)
  await update($, listTop, () => 0)
  await remember($)
}

async function digest($: EngineInterface, f: string, title: string) {
  lastActive = await $.clock.now()
  await $.prompt.submit({ text: t.digestFolder(title, command($, `tgunread.py "${f}"`)) })
  $.ui.toast(t.asked(title))
}

// A chat's summary. A person's chat, or any chat on «Private», is read without marking it read.
async function digestChat($: EngineInterface, peer: string, title: string) {
  lastActive = await $.clock.now()
  const isPrivate = (await read($, tab)) === 'private' || !peer.startsWith('-')
  const text = isPrivate ? t.digestPerson(title, command($, `tgunread.py --peer ${peer} --private`))
    : t.digestChat(title, command($, `tgunread.py --peer ${peer}`))
  await $.prompt.submit({ text })
  $.ui.toast(t.asked(title))
}

// Unread private chats: the private folder, or every chat with a person. Nothing is marked read.
async function digestPrivate($: EngineInterface) {
  lastActive = await $.clock.now()
  const f = opt.privateFolder
  await $.prompt.submit({ text: t.digestPrivate(f || t.private, command($, f ? `tgunread.py "${f}"` : 'tgunread.py --private')) })
  $.ui.toast(t.asked(f || t.private))
}

async function readAll($: EngineInterface, f: string, title: string) {
  lastActive = await $.clock.now()
  await update($, note, () => t.marking)
  const r = await run($, 'tgunread.py', [f, '--mark-only'], 300_000)
  if (r.exitCode !== 0) return void (await failed($, r, t.failed))
  await loadCache($)
  await update($, note, () => t.markedAll(title))
}

// Which chats each tab lists: «Private» — the configured folder or every private chat; «Categories» — «All chats»,
// then every named folder but the private one.
function privateChats(data: Cache) {
  if (opt.privateFolder) return data.folders[opt.privateFolder]?.chats
  return data.folders[ALL]?.chats.filter(isPrivateKind)
}
function channelFolders(data: Cache) {
  const names = (data.order ?? Object.keys(data.folders)).filter(f => f !== ALL && f !== opt.privateFolder && data.folders[f])
  return data.folders[ALL] ? [ALL, ...names] : names
}
const folderChats = (data: Cache, f: string) => data.folders[f]?.chats ?? []
// Terminal cells a character takes: 0 — joiners, variation selectors, combining marks; 2 — emoji and East Asian wide.
function cells(ch: string) {
  const c = ch.codePointAt(0)!
  if ((c >= 0x300 && c <= 0x36f) || (c >= 0x200b && c <= 0x200f) || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x20d0 && c <= 0x20ff)) return 0
  if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff00 && c <= 0xff60) || (c >= 0x1f000 && c <= 0x1faff) || c >= 0x20000) return 2
  return 1
}
// `text` cut to `width` cells, then padded with spaces to exactly that many.
function fit(text: string, width: number) {
  let out = '', used = 0
  for (const ch of text.replace(/\s+/g, ' ')) {
    const n = cells(ch)
    if (used + n > width) break
    out += ch; used += n
  }
  return out + ' '.repeat(Math.max(0, width - used))
}

// A chat list row of `width` cells: the mark, the title, the unread count, the time of the last message on the right.
function chatRow(c: CachedChat, isCurrent: boolean, width: number) {
  const time = (c.time ?? '').padStart(7)
  const count = c.unread ? ` (${c.unread})` : ''
  const name = fit(c.title, Math.max(3, width - 1 - time.length - count.length)).trimEnd()
  return fit(`${isCurrent ? '▸' : ' '}${name}${count}`, width - time.length) + time
}
const folderTitle = (f: string) => (f === ALL ? t.allChats : f)


export const register: Register = (on, options) => {
  opt = options as Options
  t = opt.language === 'ru' ? T.ru : T.en

  on('session.start', async ($, e, next) => {
    cachePath = await setup($)
    await $.command.register({ name: 'tg-pane', description: 'Telegram in a pane: private chats, channels by folder, summaries' })
    $.clock.every(60_000, () => void (isOpen && updateCounts($)))
    $.clock.every(LOGIN_POLL_MS, () => {
      void (async () => {
        const l = await read($, login)
        if (isOpen && l && l.state !== 'down' && !isFetching) await checkLogin($)
      })()
    })
    $.clock.every(POLL_MS, () => {
      void (async () => {
        const peer = await currentPeer($)
        if (!isOpen || !peer || isFetching || (await read($, login))) return
        if ((await $.clock.now()) < floodUntil) return
        if ((await $.clock.now()) - lastActive > IDLE_MS) {
          if ((await read($, note)) === '') await update($, note, () => t.paused)
          return
        }
        await fetchChat($)
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'tg-pane' }, async $ => {
    isOpen = true
    lastActive = await $.clock.now()
    if (!cachePath) cachePath = await setup($)
    if (!zoneName) await update($, askZone, () => true)
    if (!placeRestored) await restorePlace($)
    await loadCache($)
    await $.ui.open({ id: PANE, title: 'Telegram', focus: true })
    void updateCounts($)
    if (await currentPeer($)) void fetchChat($)
    return { text: 'Telegram pane opened.' }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && isOpen) {
      wasOpen = true
      $.clock.after(1_000, () => void afterClear($)) // in case the classic SessionStart below does not reach us
    }
    return next(e)
  })
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') await afterClear($)
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) isOpen = false
    return next(e)
  }).catch(($, e, next) => next(e))

  // The wheel and the keys move the open chat's own window (rows of text), the header and the input stay put.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!(await currentPeer($)) || (await read($, login))) return next(e)
    if (e.pointer && e.pointer.column < view.leftWidth && view.listLen > view.listFit) { // over the chat list
      await update($, listTop, top => Math.max(0, Math.min(view.listLen - view.listFit, top + e.by)))
      return {}
    }
    await scroll($, -e.by)
    return {}
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    const Input = 'Input' in el ? el.Input : undefined // the mobile app has no input field
    const Raster = 'Raster' in el ? el.Raster : undefined // terminal only
    isOpen = true
    const cols = e.props.bodyColumns
    const bodyRows = e.props.scroll?.bodyRows ?? (e.viewport?.rows ?? 30) - 4
    const [current, cachedData, status, themeIdx, auth, zoneAsk, pic] = await Promise.all(
      [read($, tab), read($, cache), read($, note), read($, theme), read($, login), read($, askZone), read($, viewer)])
    const pal = THEMES[themeIdx % THEMES.length]!
    const data = cachedData ?? { folders: {} }
    const priv = privateChats(data)
    const folders = channelFolders(data)
    const named = folders.filter(f => f !== ALL)
    const chanUnread = (named.length ? named : folders).reduce((s, f) => s + sum(folderChats(data, f)), 0)

    const header = (
      <Box flexDirection="row" justifyContent="space-between" width={cols}>
        <Box flexDirection="row" gap={1}>
          <Button key="tab-private" hotkey="1" variant={current === 'private' ? 'primary' : undefined}
            onPress={() => void switchTab($, 'private')}>{`${t.private} ${priv ? sum(priv) : '?'}`}</Button>
          <Button key="tab-channels" hotkey="2" variant={current === 'channels' ? 'primary' : undefined}
            onPress={() => void switchTab($, 'channels')}>{`${t.channels} ${chanUnread}`}</Button>
          {current === 'private' && priv && sum(priv) > 0 && <Button key="digest-private" onPress={() => void digestPrivate($)}>{t.summary}</Button>}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" plain onPress={() => void refresh($)}>{`↻ ${hhmm(data.updated)}`}</Button>
          <Text color={pal.accent}>●</Text>
          <Button key="theme" plain onPress={() => void setTheme($)}>{pal.name}</Button>
        </Box>
      </Box>
    )
    const footer = status ? <Text dimColor wrap="truncate-end">{status}</Text> : null

    if (pic && Raster) { // a picture over the chat: the chat is hidden behind it, ✕ (or q) closes
      return (
        <Box flexDirection="column" width={cols} alignItems="center">
          <Box flexDirection="row" justifyContent="space-between" width={cols}>
            <Text dimColor>{t.picture}</Text>
            <Button key="close-pic" hotkey="q" onPress={() => void update($, viewer, () => null)}>✕</Button>
          </Box>
          <Box borderStyle="round" borderColor={pal.frame}>
            <Raster key="pic" columns={pic.columns} rows={pic.rows} cells={pic.cells} />
          </Box>
          {footer}
        </Box>
      )
    }

    if (zoneAsk) {
      return (
        <Box flexDirection="column">
          <Text wrap="wrap">{t.tzAsk}</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
            {ZONES.map(z => <Button key={`tz-${z}`} onPress={() => void setZone($, z)}>{z}</Button>)}
          </Box>
          {Input && <Input key="tz-other" label="→" placeholder={t.tzOther} onSubmit={(value: string) => void setZone($, value)} />}
        </Box>
      )
    }

    if (auth) {
      const cmd = command($, 'tgbrowser.py')
      const qr = auth.state === 'qr' && auth.qr?.length ? qrCells(auth.qr) : null
      return (
        <Box flexDirection="column">
          {header}
          <Box flexDirection="column" marginTop={1}>
            {auth.state === 'down' && <Text>{t.down}</Text>}
            {auth.state === 'down' && <Button key="start" onPress={() => void startBrowser($)}>{t.start}</Button>}
            {auth.state === 'loading' && <Text dimColor>{t.webLoading}</Text>}
            {auth.state === 'password' && <Text wrap="wrap">{t.password(cmd)}</Text>}
            {qr && <Text wrap="wrap">{t.qr}</Text>}
            {qr && Raster && <Raster key="qr" columns={qr.columns} rows={qr.rows} cells={qr.cells} />}
            {qr && !Raster && <Text wrap="wrap">{t.qrElsewhere(cmd)}</Text>}
          </Box>
          {footer}
        </Box>
      )
    }

    const narrow = cols < NARROW
    const left = narrow ? cols : Math.min(32, Math.max(18, Math.floor(cols * 0.32)))
    const right = narrow ? cols : cols - left - 1
    const openFolderName = current === 'channels' ? await read($, folder) : null

    // Channels: the folders, each with its unread count, a preview and «Summary».
    if (current === 'channels' && openFolderName === null) {
      const rows = Math.max(6, bodyRows - 4)
      const withPreview = folders.length * 2 <= rows
      view.leftWidth = 0
      return (
        <Box flexDirection="column">
          {header}
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={pal.frame} paddingX={1} width={cols}>
            {folders.map(f => {
              const chats = folderChats(data, f)
              const n = sum(chats)
              const top = chats.filter(c => c.unread > 0).sort((a, b) => b.unread - a.unread)
              return (
                <Box key={`row-${f}`} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Button key={`folder-${f}`} plain onPress={() => void openFolder($, f)}>
                      {`▸ ${folderTitle(f)} — ${n} ${t.unread}`}
                    </Button>
                    {n > 0 && <Button key={`digest-${f}`} onPress={() => void digest($, f, folderTitle(f))}>{t.summary}</Button>}
                  </Box>
                  {withPreview && (
                    <Text dimColor wrap="truncate-end">
                      {`  ${top.length ? top.slice(0, 6).map(c => `${c.title} ${c.unread}`).join(' · ') : t.allRead}`}
                    </Text>
                  )}
                </Box>
              )
            })}
          </Box>
          {footer}
        </Box>
      )
    }

    // A chat list beside (or, narrow, instead of) the open chat.
    const listed = current === 'private' ? priv ?? [] : folderChats(data, openFolderName!)
    const [peer, history, top, hidden] = await Promise.all([currentPeer($), read($, chat), read($, listTop), read($, lift)])
    const shown = history?.peer === peer ? history : null
    const cached = listed.find(c => c.id === peer)
    const kind: Kind | undefined = shown?.kind ?? cached?.kind
    const title = shown?.title ?? cached?.title
    const unread = cached?.unread ?? shown?.unread ?? 0
    const isChannel = kind === 'channel' || (!kind && !!peer?.startsWith('-') && current === 'channels')
    const writable = !!peer && kind !== 'channel'
    const n = await read($, draft)

    const folderBar = current === 'channels' && (
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="folders" onPress={() => void openFolder($, null)}>{t.folders}</Button>
        <Text bold color={pal.accent}>{`${folderTitle(openFolderName!)} ${sum(listed)}`}</Text>
        {sum(listed) > 0 && <Button key={`digest-${openFolderName}`} onPress={() => void digest($, openFolderName!, folderTitle(openFolderName!))}>{t.summary}</Button>}
        {sum(listed) > 0 && <Button key="readall" onPress={() => void readAll($, openFolderName!, folderTitle(openFolderName!))}>{t.readAll}</Button>}
      </Box>
    )

    // Height budget: header, gap, [folder bar + gap], boxed input (3), status line, one spare row (so the engine
    // always has something to scroll and keeps raising the wheel for us).
    const inputRows = writable ? 3 : 0
    const boxH = Math.max(7, bodyRows - 2 - (folderBar ? 2 : 0) - inputRows - 2)
    const listFit = boxH - 2
    const sorted = [...listed].sort(unreadFirst)
    const paged = sorted.length > listFit
    const size = paged ? listFit - 1 : listFit
    const from = Math.min(top, Math.max(0, sorted.length - size))
    view.leftWidth = narrow ? 0 : left
    view.listLen = sorted.length
    view.listFit = size
    const list = (
      <Box flexDirection="column" width={left} height={boxH} borderStyle="round" borderColor={pal.frame}>
        {sorted.slice(from, from + size).map(c => (
          <Button key={`chat-${c.id}`} plain dimColor={(c.unread === 0 || c.muted) && c.id !== peer}
            onPress={() => void openChat($, c.id, current === 'channels' && opt.autoReadChannels !== false && c.kind === 'channel')}>
            {chatRow(c, c.id === peer, left - 3)}
          </Button>
        ))}
        {paged && (
          <Box flexDirection="row" gap={1}>
            {from > 0 && <Button key="list-up" plain onPress={() => void update($, listTop, () => Math.max(0, from - size))}>▲</Button>}
            {from + size < sorted.length && <Button key="list-down" plain onPress={() => void update($, listTop, () => from + size)}>▼</Button>}
            <Text dimColor>{`${from + 1}–${Math.min(from + size, sorted.length)}/${sorted.length}`}</Text>
          </Box>
        )}
      </Box>
    )

    const inner = right - 4 // border and padding
    const fit = boxH - 3 // border and the title row
    const textW = inner - 9 // bar, space, time
    const rowsAll = layoutMessages(shown?.messages ?? [], textW, k => t.openMedia(t.mediaKind[k] ?? k), kind === 'group')
    view.total = rowsAll.length
    view.fit = fit
    const lifted = Math.min(hidden, Math.max(0, rowsAll.length - fit))
    const end = rowsAll.length - lifted
    const slice = rowsAll.slice(Math.max(0, end - fit), end)
    const step = Math.max(1, fit - 2)
    const msgView = (
      <Box flexDirection="column" width={right} height={boxH} borderStyle="round" borderColor={peer ? pal.accent : pal.frame} paddingX={1}>
        {!peer && <Text dimColor wrap="wrap">{current === 'private' ? t.pickChat : t.pick}</Text>}
        {peer && (
          <Box flexDirection="row" justifyContent="space-between" width={inner}>
            <Box flexDirection="row" gap={1}>
              {narrow && <Button key="back-list" onPress={() => void closeChat($)}>{t.chats}</Button>}
              <Text bold color={pal.accent} wrap="truncate-end">{title ?? '…'}</Text>
              {unread > 0 && <Button key="mark-read" onPress={() => void markRead($)}>{t.read(unread)}</Button>}
              <Button key="digest-chat" onPress={() => void digestChat($, peer, title ?? peer)}>{t.summary}</Button>
            </Box>
            <Box flexDirection="row" gap={1}>
              <Button key="older" plain onPress={() => void scroll($, step)}>▲</Button>
              <Button key="newer" plain onPress={() => void scroll($, -step)}>▼</Button>
            </Box>
          </Box>
        )}
        {peer && slice.length === 0 && shown && <Text dimColor>{t.nothingYet}</Text>}
        {slice.map(m => m.isDate ? (
          <Box key={m.key} width={inner} justifyContent="center"><Text dimColor>{`── ${m.text} ──`}</Text></Box>
        ) : m.media ? (
          <Box key={m.key} flexDirection="row" width={inner}>
            <Text color={m.out ? pal.accent : undefined} dimColor={!m.out}>▎ </Text>
            <Button key={`media-${m.media.mid}`} plain onPress={() => void openMedia($, m.media!.mid, cols - 4, bodyRows - 6)}>{m.text}</Button>
          </Box>
        ) : (
          <Box key={m.key} flexDirection="row" width={inner}>
            <Text color={m.out ? pal.accent : undefined} dimColor={!m.out}>▎ </Text>
            <Box width={textW}><Text wrap="truncate-end" color={m.out ? pal.accent : undefined}>{m.text}</Text></Box>
            <Box width={6} flexShrink={0} justifyContent="flex-end"><Text dimColor>{m.time ?? ''}</Text></Box>
          </Box>
        ))}
        {lifted > 0 && <Box position="absolute" right={1} bottom={0}><Text dimColor>{`▼ ${lifted}`}</Text></Box>}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {header}
        {folderBar}
        <Box flexDirection="row" marginTop={1} gap={narrow ? 0 : 1}>
          {(!narrow || !peer) && list}
          {(!narrow || peer) && msgView}
        </Box>
        {peer && !writable && <Text dimColor>{t.readOnly}</Text>}
        {writable && (
          <Box borderStyle="round" borderColor={pal.accent} paddingX={1} width={cols}>
            {Input ? <Input key={`msg-${n}`} label={`→ ${(title ?? '').slice(0, 20)}`}
              placeholder={t.placeholder} submitLabel={t.send}
              onSubmit={(value: string) => void send($, value)} /> : <Text dimColor>{t.terminalOnly}</Text>}
          </Box>
        )}
        {footer ?? <Text> </Text>}
        <Text> </Text>
      </Box>
    )
  })
}
