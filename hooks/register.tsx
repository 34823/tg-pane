import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cache, CachedChat, Forward, Found, History, Hit, Kind, ListSearch, Login, Message, Mode, Tab, Viewer } from '../types'

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
    ok: 'all good', sent: 'sent', notSent: 'NOT sent', failed: 'failed', counts: 'counters', updating: 'updating counters…',
    flood: 'Telegram asks to slow down — pausing for 10 min', restarting: 'starting the Telegram browser…',
    paused: 'auto-refresh paused — press «Refresh»', pickChat: 'Pick a chat on the left. The other person sees «read» only after you reply.',
    pickFirst: 'Pick a chat first', summary: 'Summary', readAll: 'Mark all read',
    folders: '← Folders', chats: '← Chats', allRead: 'all read', unread: 'unread', older: '▲ older', newer: '▼ newer', theme: 'theme', openMedia: (k: string) => `▣ ${k} · open`, mediaKind: { photo: 'photo', image: 'image', video: 'video (preview)', file: 'file' } as Record<string, string>,
    mediaLoading: 'downloading the picture…', mediaFail: 'could not get the picture', nothingYet: 'No messages yet', pick: 'pick a chat',
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
    searchList: 'search chats and messages', searchChat: 'search in this chat', found: (n: number) => `found: ${n}`, nothingFound: 'nothing found', searching: 'searching…',
    chatsHead: 'chats', hitsHead: 'messages', clear: 'clear',
    reply: '↩ reply', edit: '✎ edit', del: '⌫ delete', react: '☺ react', forward: '↪ forward', cancel: '✕',
    replying: (q: string) => `↪ reply: «${q}»`, editing: '✎ editing the message', confirmDel: 'Delete for everyone?', yes: 'yes', no: 'no',
    fwdTitle: 'Forward to…', fwdFilter: 'filter chats, Enter', fwdAsk: (n: string) => `Forward to «${n}»?`, fwdNone: 'no such chat',
    unreadWord: 'unread', day: 'day', week: 'week', month: 'month', toNew: '⤓ latest',
    transcribe: (k: string) => (k === 'round' ? '◉ video note · transcribe' : '♪ voice · transcribe'), transcribing: 'transcribing…', trFailed: 'could not transcribe (Telegram Premium needed)',
    done: 'done', working: 'working…', forwarded: '↪ forwarded',
    digestSince: (t: string, cmd: string, label: string) =>
      `Summarize the Telegram «${t}» for the period «${label}»: run \`${cmd}\` (it prints the posts of that period and marks NOTHING read) ` +
      `and retell them by topic, most important first, 1–2 lines per topic; name the channels at the end.`,
    tzAsk: 'Your time zone? Message times are shown in it.', tzOther: 'or type a name like Europe/Berlin, Enter',
    tzBad: (z: string) => `«${z}» is not a time zone`,
  },
  ru: {
    private: 'Личные', channels: 'Категории', refresh: 'Обновить', cache: 'кэш', allChats: 'Все чаты',
    noCache: 'нет кэша счётчиков — нажми «Обновить»', loading: 'загружаю…', marking: 'помечаю прочитанным…', sending: 'отправляю…',
    ok: 'всё в порядке', sent: 'отправлено', notSent: 'НЕ отправлено', failed: 'ошибка', counts: 'счётчики', updating: 'обновляю счётчики…',
    flood: 'Telegram просит притормозить — пауза 10 мин', restarting: 'запускаю браузер Telegram…',
    paused: 'автообновление на паузе — нажми «Обновить»', pickChat: 'Выбери чат слева. Собеседник увидит «прочитано», только когда ответишь.',
    pickFirst: 'Сначала выбери чат', summary: 'Сводка', readAll: 'Прочитать всё',
    folders: '← Папки', chats: '← Чаты', allRead: 'всё прочитано', unread: 'непрочит.', older: '▲ раньше', newer: '▼ позже', theme: 'тема', openMedia: (k: string) => `▣ ${k} · открыть`, mediaKind: { photo: 'фото', image: 'картинка', video: 'видео (превью)', file: 'файл' } as Record<string, string>,
    mediaLoading: 'скачиваю картинку…', mediaFail: 'не удалось получить картинку', nothingYet: 'Сообщений пока нет', pick: 'выбери чат',
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
    searchList: 'поиск по чатам и сообщениям', searchChat: 'поиск в этом чате', found: (n: number) => `найдено: ${n}`, nothingFound: 'ничего не найдено', searching: 'ищу…',
    chatsHead: 'чаты', hitsHead: 'сообщения', clear: 'сбросить',
    reply: '↩ ответ', edit: '✎ правка', del: '⌫ удалить', react: '☺ реакция', forward: '↪ переслать', cancel: '✕',
    replying: (q: string) => `↪ ответ: «${q}»`, editing: '✎ правка сообщения', confirmDel: 'Удалить у всех?', yes: 'да', no: 'нет',
    fwdTitle: 'Переслать в…', fwdFilter: 'фильтр чатов, Enter', fwdAsk: (n: string) => `Переслать в «${n}»?`, fwdNone: 'нет такого чата',
    unreadWord: 'непрочит.', day: 'день', week: 'неделя', month: 'месяц', toNew: '⤓ к новым',
    transcribe: (k: string) => (k === 'round' ? '◉ кружок · расшифровать' : '♪ голосовое · расшифровать'), transcribing: 'расшифровываю…', trFailed: 'не удалось расшифровать (нужен Telegram Premium)',
    done: 'готово', working: 'делаю…', forwarded: '↪ переслано',
    digestSince: (t: string, cmd: string, label: string) =>
      `Сводка по Telegram «${t}» за период «${label}»: запусти \`${cmd}\` (печатает посты за этот период и НИЧЕГО не помечает прочитанным) ` +
      `и перескажи по-русски по темам, главное сверху, 1–2 строки на тему; в конце — какие каналы были.`,
    tzAsk: 'Твой часовой пояс? В нём показывается время сообщений.', tzOther: 'или впиши название, например Europe/Berlin, Enter',
    tzBad: (z: string) => `«${z}» — не часовой пояс`,
  },
}
type Strings = (typeof T)['en']
type Period = 'day' | 'week' | 'month'
const PERIODS: Period[] = ['day', 'week', 'month']

const tab = atom({ plugin: 'tg-pane', key: 'tab' } as const, 'private' as Tab)
const cache = atom({ plugin: 'tg-pane', key: 'cache' } as const, null as Cache | null)
const selected = atom({ plugin: 'tg-pane', key: 'selected' } as const, null as string | null) // chat on «Private»
const channel = atom({ plugin: 'tg-pane', key: 'channel' } as const, null as string | null) // chat on «Channels»
const folder = atom({ plugin: 'tg-pane', key: 'folder' } as const, null as string | null) // open folder on «Channels»
const chat = atom({ plugin: 'tg-pane', key: 'chat' } as const, null as History | null)
const lift = atom({ plugin: 'tg-pane', key: 'lift' } as const, 0) // how many rows (lines) of the newest messages are scrolled out of view
const theme = atom({ plugin: 'tg-pane', key: 'theme' } as const, 0) // index into THEMES
const listTop = atom({ plugin: 'tg-pane', key: 'listTop' } as const, 0) // first shown row of the chat list
const login = atom({ plugin: 'tg-pane', key: 'login' } as const, null as Login | null) // not logged in: what to show
const note = atom({ plugin: 'tg-pane', key: 'note' } as const, '')
const draft = atom({ plugin: 'tg-pane', key: 'draft' } as const, 0)
const askZone = atom({ plugin: 'tg-pane', key: 'askZone' } as const, false) // no time zone known: ask first
const sel = atom({ plugin: 'tg-pane', key: 'sel' } as const, null as number | null) // the message picked with one press: its actions are in the chat's top row
const mode = atom({ plugin: 'tg-pane', key: 'mode' } as const, null as Mode | null) // the input answers a message (two presses) or rewrites mine
const toolbar = atom({ plugin: 'tg-pane', key: 'toolbar' } as const, '' as '' | 'react' | 'delete') // the top row asks which reaction / «delete?»
const fwd = atom({ plugin: 'tg-pane', key: 'fwd' } as const, null as Forward | null) // choosing where to forward
const found = atom({ plugin: 'tg-pane', key: 'found' } as const, null as Found | null) // search inside the open chat
const jump = atom({ plugin: 'tg-pane', key: 'jump' } as const, null as number | null) // a window around a found message is shown (not the newest ones)
const listQ = atom({ plugin: 'tg-pane', key: 'listQ' } as const, null as ListSearch | null) // search above the chat list
const sumMenu = atom({ plugin: 'tg-pane', key: 'sumMenu' } as const, null as string | null) // which «Summary» shows its period choices
const trs = atom({ plugin: 'tg-pane', key: 'trs' } as const, {} as Record<string, string>) // transcripts of voice messages, by «peer:mid»

// Live until the module reloads: is the pane open, when the person last did something, is a request running,
// was another load asked for meanwhile, does the chat wait to be marked read, the FLOOD_WAIT pause, the last restart.
let isOpen = false
let lastActive = 0
let isFetching = false
let fetchAgain = false
let readWanted = false
let replaceWanted = false // the next load replaces the shown messages instead of joining them (back from a found message to the newest)
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
// Senders in a group: a colour per name, the same every time.
const SENDER_COLORS = ['#f59e0b', '#60a5fa', '#34d399', '#f472b6', '#c084fc', '#f87171', '#22d3ee', '#a3e635']
const senderColor = (name: string) => SENDER_COLORS[[...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % SENDER_COLORS.length]!

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

type Row = {
  key: string; text: string; mid?: number; time?: string; out?: boolean; isDate?: boolean; sender?: string; head?: boolean
  line?: boolean // a line of the message's own text: a press on it picks the message
  meta?: boolean // a quiet row of a message: what it answers, forwarded, reactions, a transcript
  edited?: boolean; media?: { mid: number; kind: string }; trans?: { mid: number; kind: string }
}

// Every message as rows (one per line, whole text, nothing cut), with a date row where the day changes, rows for what it
// answers / who it came from / reactions, a row with the «open» button under a picture and the «transcribe» button (or the
// transcript, `texts[mid]`; '…' while it is being made) under a voice message or a round video.
// `names` undefined — a channel; otherwise a name row opens each run of one sender's messages (in a group the sender is `from`, in a private chat `them`).
export function layoutMessages(messages: Message[], width: number, openLabel: (kind: string) => string = k => k, names?: { me: string; them?: string },
  texts: Record<number, string> = {}, fwdLabel: (from: string | true) => string = f => `↪ ${f === true ? '' : f}`) {
  const out: Row[] = []
  messages.forEach((m, i) => {
    if (m.date && m.date !== messages[i - 1]?.date) out.push({ key: `d${m.mid}`, text: m.date, isDate: true })
    const body = m.text.replace(/^\[media\] ?/, '')
    const sender = !names ? undefined : m.out ? names.me : m.from ?? names.them
    const prev = messages[i - 1]
    if (sender && (!prev || sender !== (prev.out ? names!.me : prev.from ?? names!.them) || m.date !== prev.date)) out.push({ key: `h${m.mid}`, text: sender, head: true, mid: m.mid, sender, out: m.out })
    const quiet = (key: string, text: string) => out.push({ key: `${key}${m.mid}`, text, mid: m.mid, meta: true, out: m.out, sender })
    if (m.reply) quiet('q', `↩ ${m.reply.text || '…'}`)
    if (m.fwd) quiet('f', fwdLabel(m.fwd))
    wrapLines(body, width).forEach((text, j) => out.push({ key: `m${m.mid}-${j}`, text, mid: m.mid, line: true, time: j === 0 ? m.time : undefined, edited: j === 0 && !!m.edited, out: m.out, sender }))
    if (m.media === 'voice' || m.media === 'round') {
      const tx = texts[m.mid]
      if (tx === undefined) out.push({ key: `o${m.mid}`, text: openLabel(m.media), mid: m.mid, out: m.out, sender, trans: { mid: m.mid, kind: m.media } })
      else if (tx === '…') quiet('o', openLabel('busy'))
      else wrapLines(`♪ ${tx}`, width).forEach((text, j) => out.push({ key: `o${m.mid}-${j}`, text, mid: m.mid, meta: true, out: m.out, sender }))
    } else if (m.media && m.media !== 'file') out.push({ key: `o${m.mid}`, text: openLabel(m.media), mid: m.mid, out: m.out, sender, media: { mid: m.mid, kind: m.media } })
    if (m.reactions?.length) quiet('r', m.reactions.map(r => (r.me ? `[${r.e} ${r.n}]` : `${r.e} ${r.n}`)).join('  '))
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
  if ((await read($, jump)) !== null && !replaceWanted) return // a window around a found message: the newest ones would tear a gap into it
  isFetching = true
  try {
    do {
      fetchAgain = false
      const peer = await currentPeer($)
      if (!peer) return
      const andRead = readWanted
      const replace = replaceWanted
      readWanted = false
      replaceWanted = false
      const r = await run($, 'tgchat.py', andRead ? [peer, String(PAGE), '--read'] : [peer, String(PAGE)])
      if (andRead) await loadCache($) // tgchat.py --read zeroed this chat's counter in the cache
      if ((await currentPeer($)) !== peer) continue // another chat was picked meanwhile — load that one
      if (r.exitCode !== 0) return void (await failed($, r, t.failed))
      const fresh = JSON.parse(r.stdout) as History
      await update($, chat, old => {
        if (replace || old?.peer !== peer || !fresh.messages.length) return fresh
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
const view = { total: 0, fit: 0, textW: 40, leftWidth: 0, listLen: 0, listFit: 0 }

// The rows of a chat as the last drawing laid them out (the same call the drawing makes).
function rowsOf(h: History | null, texts: Record<number, string>) {
  return layoutMessages(h?.messages ?? [], view.textW, k => (k === 'busy' ? t.transcribing : k === 'voice' || k === 'round' ? t.transcribe(k) : t.openMedia(t.mediaKind[k] ?? k)),
    h?.kind === 'channel' ? undefined : { me: t.me, them: h?.title }, texts, f => (f === true ? t.forwarded : `${t.forwarded} ${f}`))
}

// Moves the open chat's window by `step` rows (positive — toward older), at once; older messages load in the
// background when the top is near, the view stays where it is.
async function scroll($: EngineInterface, step: number) {
  lastActive = await $.clock.now()
  const now = await read($, lift)
  const max = Math.max(0, view.total - view.fit)
  const to = Math.max(0, Math.min(max, now + step))
  if (to !== now) await update($, lift, () => to)
  if (step > 0 && max - to < 6) void loadOlder($)
  if (step < 0 && to === 0) void loadNewer($) // the bottom of a window around a found message: the messages after it
}

async function setTheme($: EngineInterface, i?: number) {
  const next = (i ?? (await read($, theme)) + 1) % THEMES.length
  await update($, theme, () => next)
  await $.store.set('theme', next)
}

const viewer = atom({ plugin: 'tg-pane', key: 'viewer' } as const, null as Viewer | null) // a picture open over the chat

// The picture drawn over the pane with Kitty graphics, straight into the terminal (tgview.py); the pane keeps a blank box and ✕.
async function showPicture($: EngineInterface, file: string, cols: number) {
  const r = await run($, 'tgview.py', ['show', file, String(cols)], 20_000)
  if (r.exitCode !== 0) return void (await update($, note, () => `${t.mediaFail}: ${r.stderr.trim().slice(-100)}`))
  await update($, viewer, () => ({ file }))
}

async function closePicture($: EngineInterface) {
  await run($, 'tgview.py', ['clear'], 10_000)
  await update($, viewer, () => null)
}

// A picture of a message: downloaded on request, drawn over the pane.
async function openMedia($: EngineInterface, mid: number, cols: number) {
  lastActive = await $.clock.now()
  const peer = await currentPeer($)
  if (!peer) return
  await update($, note, () => t.mediaLoading)
  const r = await run($, 'tgmedia.py', [peer, String(mid)], 120_000)
  if (r.exitCode !== 0) return void (await failed($, r, t.mediaFail))
  const file = r.stdout.trim().split('\n').pop() ?? ''
  await update($, note, () => '')
  await showPicture($, file, cols)
}

// Nothing picked, no search, no half-made reply: what belongs to the chat that was open.
async function clearPick($: EngineInterface) {
  if ((await read($, mode))?.kind === 'edit') await update($, draft, n => n + 1) // the field held the old text
  await Promise.all([update($, sel, () => null), update($, mode, () => null), update($, toolbar, () => ''), update($, fwd, () => null),
    update($, found, () => null), update($, jump, () => null), update($, sumMenu, () => null)])
}

async function openChat($: EngineInterface, peer: string, andRead = false, at = 0) {
  lastActive = await $.clock.now()
  readWanted = andRead
  if ((await read($, tab)) === 'private') await update($, selected, () => peer)
  else await update($, channel, () => peer)
  await update($, chat, () => null)
  await update($, lift, () => 0)
  await update($, note, () => t.loading)
  await clearPick($)
  await remember($)
  if (at) await jumpTo($, at)
  else await fetchChat($)
}

async function closeChat($: EngineInterface) {
  if ((await read($, tab)) === 'private') await update($, selected, () => null)
  else await update($, channel, () => null)
  await update($, chat, () => null)
  await clearPick($)
  await remember($)
}

let sendChain: Promise<unknown> = Promise.resolve() // everything that writes to Telegram goes out one by one, in the order pressed

// A fresh, empty message field with the cursor in it: the next message can be typed while this one goes out.
async function freshInput($: EngineInterface) {
  const next = (await read($, draft)) + 1
  await update($, draft, () => next)
  await focusInput($)
}

async function focusInput($: EngineInterface) {
  const n = await read($, draft)
  for (const wait of [0, 120, 400]) { // the field is drawn on the next render
    if (wait) await new Promise(r => setTimeout(r, wait))
    const f = await $.ui.focus({ requestId: PANE, key: `msg-${n}` }).catch(() => ({ deny: 'x' }))
    if (!('deny' in f)) break
  }
}

// One thing for Telegram to do (a message, an edit, a reaction…): queued behind the earlier ones, then the chat is read again.
function queue($: EngineInterface, job: () => Promise<boolean>) {
  sendChain = sendChain.then(async () => {
    if (await job()) await fetchChat($)
  })
}

async function send($: EngineInterface, text: string) {
  const peer = await currentPeer($)
  if (!text.trim()) return
  if (!peer) return void $.ui.toast(t.pickFirst)
  lastActive = await $.clock.now()
  const m = await read($, mode) // taken now: the next message may start another reply while this one is still going out
  if (m?.kind === 'edit') return void (await editMessage($, peer, m.mid, text))
  const replyTo = m?.kind === 'reply' ? m.mid : 0
  await update($, mode, () => null)
  await update($, sel, () => null)
  await update($, note, () => t.sending)
  await update($, draft, n => n + 1) // an empty field at once; the cursor goes into it once the message is queued
  const back = (await read($, jump)) !== null // a window around a found message: after sending, the newest ones again
  if (back) { await update($, jump, () => null); replaceWanted = true }
  queue($, async () => {
    const r = await run($, 'tgmsg.py', ['--peer', peer, ...(replyTo ? ['--reply', String(replyTo)] : []), text], 300_000)
    if (r.exitCode !== 0) {
      await failed($, r, t.notSent)
      return false
    }
    await update($, lift, () => 0)
    await update($, note, () => t.sent)
    await loadCache($) // replied = the chat is read, tgmsg zeroed its counter
    return true
  })
  await focusInput($)
}

// ---- the message that was picked: one press picks it (actions in the top row), two presses make it the reply's target
const DOUBLE_MS = 450
let lastPress = { mid: 0, at: -Infinity }
export function isDoublePress(last: { mid: number; at: number }, mid: number, now: number, gap = DOUBLE_MS) {
  return last.mid === mid && now - last.at <= gap
}

const bare = (m: Message) => m.text.replace(/^\[media\] ?/, '')

async function pickMessage($: EngineInterface, mid: number) {
  const now = await $.clock.now()
  lastActive = now
  const dbl = isDoublePress(lastPress, mid, now)
  lastPress = dbl ? { mid: 0, at: -Infinity } : { mid, at: now }
  if (dbl) return void (await startReply($, mid))
  const [cur, md] = await Promise.all([read($, sel), read($, mode)])
  if (md) {
    await update($, mode, () => null)
    if (md.kind === 'edit') await update($, draft, n => n + 1)
  }
  await update($, toolbar, () => '')
  await update($, sel, () => (cur === mid && !md ? null : mid)) // pressing the picked one again lets it go
}

async function startReply($: EngineInterface, mid: number) {
  const h = await read($, chat)
  const m = h?.messages.find(x => x.mid === mid)
  if (!m || h?.kind === 'channel') return // a channel: nothing to write
  const quote = (bare(m) || m.media || '…').replace(/\s+/g, ' ').slice(0, 60)
  await update($, mode, () => ({ kind: 'reply', mid, text: quote }))
  await update($, sel, () => mid)
  await update($, toolbar, () => '')
  await focusInput($)
}

async function startEdit($: EngineInterface, mid: number) {
  const m = (await read($, chat))?.messages.find(x => x.mid === mid)
  if (!m?.out) return
  await update($, mode, () => ({ kind: 'edit', mid, text: bare(m) }))
  await update($, toolbar, () => '')
  await freshInput($) // a new field that holds the text
}

async function cancelMode($: EngineInterface) {
  const md = await read($, mode)
  await update($, mode, () => null)
  await update($, sel, () => null)
  if (md?.kind === 'edit') await update($, draft, n => n + 1)
}

const patchMessage = (mid: number, fn: (m: Message) => Message | null) => (old: History | null) =>
  old ? { ...old, messages: old.messages.flatMap(m => (m.mid === mid ? fn(m) ?? [] : [m])) } : old

async function editMessage($: EngineInterface, peer: string, mid: number, text: string) {
  await update($, mode, () => null)
  await update($, sel, () => null)
  await update($, note, () => t.working)
  await update($, draft, n => n + 1)
  queue($, async () => {
    const r = await run($, 'tgact.py', ['edit', peer, String(mid), text], 120_000)
    if (r.exitCode !== 0) {
      await failed($, r, t.failed)
      return false
    }
    await update($, chat, patchMessage(mid, m => ({ ...m, text: (m.media ? '[media] ' : '') + text, edited: true })))
    await update($, note, () => t.done)
    return false
  })
}

async function deleteMessage($: EngineInterface, mid: number) {
  const peer = await currentPeer($)
  if (!peer) return
  await update($, toolbar, () => '')
  await update($, sel, () => null)
  await update($, note, () => t.working)
  queue($, async () => {
    const r = await run($, 'tgact.py', ['delete', peer, String(mid)], 120_000)
    if (r.exitCode !== 0) {
      await failed($, r, t.failed)
      return false
    }
    await update($, chat, patchMessage(mid, () => null))
    await update($, note, () => t.done)
    return false
  })
}

async function reactTo($: EngineInterface, mid: number, emoji: string) {
  const peer = await currentPeer($)
  if (!peer) return
  await update($, toolbar, () => '')
  await update($, sel, () => null)
  await update($, note, () => t.working)
  queue($, async () => {
    const r = await run($, 'tgact.py', ['react', peer, String(mid), emoji], 120_000)
    if (r.exitCode !== 0) {
      await failed($, r, t.failed)
      return false
    }
    await update($, note, () => t.done)
    return true // read the chat again: the reaction is under the message
  })
}

async function startForward($: EngineInterface, mid: number) {
  await update($, toolbar, () => '')
  await update($, fwd, () => ({ mid, q: '', to: null }))
}

async function forwardTo($: EngineInterface, to: string) {
  const f = await read($, fwd)
  const peer = await currentPeer($)
  if (!f || !peer) return
  await update($, fwd, () => null)
  await update($, sel, () => null)
  await update($, note, () => t.working)
  queue($, async () => {
    const r = await run($, 'tgact.py', ['forward', peer, String(f.mid), to], 120_000)
    if (r.exitCode !== 0) {
      await failed($, r, t.failed)
      return false
    }
    await update($, note, () => t.done)
    return to === peer // forwarded into this very chat: it shows up here
  })
}

// Telegram Premium's text of a voice message or a round video, on request; kept until the pane reloads.
async function transcribe($: EngineInterface, mid: number) {
  lastActive = await $.clock.now()
  const peer = await currentPeer($)
  if (!peer) return
  const key = `${peer}:${mid}`
  await update($, trs, old => ({ ...old, [key]: '…' }))
  const r = await run($, 'tgact.py', ['transcribe', peer, String(mid)], 180_000)
  if (r.exitCode !== 0) {
    await update($, trs, old => Object.fromEntries(Object.entries(old).filter(([k]) => k !== key)))
    return void (await update($, note, () => `${t.trFailed}: ${r.stderr.trim().slice(-80)}`))
  }
  await update($, trs, old => ({ ...old, [key]: r.stdout.trim() || '…' }))
}

// ---- search inside the open chat
async function openSearch($: EngineInterface) {
  await update($, toolbar, () => '')
  await update($, sel, () => null)
  await update($, found, () => ({ q: '', hits: null }))
}

async function runSearch($: EngineInterface, q: string) {
  lastActive = await $.clock.now()
  const peer = await currentPeer($)
  if (!peer) return
  q = q.trim()
  if (!q) return void (await update($, found, () => ({ q: '', hits: null })))
  await update($, found, () => ({ q, hits: null }))
  await update($, note, () => t.searching)
  const r = await run($, 'tgchat.py', [peer, '30', '--query', q])
  if (r.exitCode !== 0) return void (await failed($, r, t.failed))
  const hits = (JSON.parse(r.stdout) as History).messages.reverse() // newest first
  await update($, found, old => (old?.q === q ? { q, hits } : old))
  await update($, note, () => '')
}

// A window around message `mid` (a search hit), the message highlighted and in the middle of the view.
async function jumpTo($: EngineInterface, mid: number) {
  lastActive = await $.clock.now()
  const peer = await currentPeer($)
  if (!peer) return
  await update($, note, () => t.loading)
  const r = await run($, 'tgchat.py', [peer, String(PAGE), '--around', String(mid)])
  if (r.exitCode !== 0) return void (await failed($, r, t.failed))
  if ((await currentPeer($)) !== peer) return // another chat was picked meanwhile
  const fresh = JSON.parse(r.stdout) as History
  await update($, chat, () => fresh)
  await update($, jump, () => mid)
  await update($, found, () => null)
  await update($, sel, () => null)
  const rows = rowsOf(fresh, {})
  const at = rows.findIndex(x => x.mid === mid && x.line)
  const end = at < 0 ? rows.length : Math.min(rows.length, at + 1 + Math.floor(view.fit / 2))
  await update($, lift, () => Math.max(0, Math.min(rows.length - end, rows.length - view.fit)))
  await update($, note, () => '')
}

// Back from a window around a found message to the newest ones.
async function toNewest($: EngineInterface) {
  await update($, jump, () => null)
  await update($, lift, () => 0)
  replaceWanted = true
  await fetchChat($)
}

async function loadNewer($: EngineInterface) {
  const h = await read($, chat)
  const peer = await currentPeer($)
  if (!h || h.peer !== peer || !h.messages.length || isFetching || (await read($, jump)) === null) return
  isFetching = true
  let atEnd = false
  try {
    const last = h.messages.at(-1)!.mid
    const r = await run($, 'tgchat.py', [peer!, String(PAGE), '--after', String(last)])
    if (r.exitCode !== 0) return void (await failed($, r, t.failed))
    const newer = (JSON.parse(r.stdout) as History).messages.filter(m => m.mid > last)
    atEnd = newer.length < PAGE - 2
    await update($, chat, old => (old?.peer === peer ? { ...old, messages: [...old.messages, ...newer.filter(m => m.mid > old.messages.at(-1)!.mid)] } : old))
  } finally {
    isFetching = false
  }
  if (atEnd) { await update($, jump, () => null); await fetchChat($) } // reached the newest: live again
}

// ---- search above the chat list: chat names at once, message texts from Telegram
async function runListSearch($: EngineInterface, q: string) {
  lastActive = await $.clock.now()
  q = q.trim()
  if (!q) return void (await update($, listQ, () => null))
  await update($, listQ, () => ({ q, hits: null }))
  await update($, listTop, () => 0)
  if (q.length < 2) return
  await update($, note, () => t.searching)
  const r = await run($, 'tgsearch.py', [q, '15'])
  if (r.exitCode !== 0) return void (await failed($, r, t.failed))
  const hits = (JSON.parse(r.stdout) as { hits: Hit[] }).hits
  await update($, listQ, old => (old?.q === q ? { q, hits } : old))
  await update($, note, () => '')
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
  await update($, listQ, () => null)
  await update($, note, () => '')
  await clearPick($)
  await remember($)
  if (await currentPeer($)) await fetchChat($)
}

async function openFolder($: EngineInterface, f: string | null) {
  lastActive = await $.clock.now()
  await update($, folder, () => f)
  await update($, channel, () => null)
  await update($, chat, () => null)
  await update($, listTop, () => 0)
  await update($, listQ, () => null)
  await clearPick($)
  await remember($)
}

async function digest($: EngineInterface, f: string, title: string) {
  lastActive = await $.clock.now()
  await update($, sumMenu, () => null)
  await $.prompt.submit({ text: t.digestFolder(title, command($, `tgunread.py "${f}"`)) })
  $.ui.toast(t.asked(title))
}

// A channel's or group's summary of the unread posts (it marks them read, as opening a channel does).
async function digestChat($: EngineInterface, peer: string, title: string) {
  lastActive = await $.clock.now()
  await update($, sumMenu, () => null)
  await $.prompt.submit({ text: t.digestChat(title, command($, `tgunread.py --peer ${peer}`)) })
  $.ui.toast(t.asked(title))
}

// Everything a folder or a chat posted in the last day / week / month; marks nothing read.
async function digestPeriod($: EngineInterface, target: { folder?: string; peer?: string }, title: string, period: Period) {
  lastActive = await $.clock.now()
  await update($, sumMenu, () => null)
  const cmd = target.peer ? `tgunread.py --peer ${target.peer} --since ${period}` : `tgunread.py "${target.folder}" --since ${period}`
  await $.prompt.submit({ text: t.digestSince(title, command($, cmd), t[period]) })
  $.ui.toast(t.asked(title))
}

async function toggleMenu($: EngineInterface, key: string) {
  lastActive = await $.clock.now()
  await update($, sumMenu, old => (old === key ? null : key))
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
    if (await read($, login)) return next(e)
    if (e.pointer && e.pointer.column < view.leftWidth && view.listLen > view.listFit) { // over the chat list (also with no chat open)
      await update($, listTop, top => Math.max(0, Math.min(view.listLen - view.listFit, top + e.by)))
      return {}
    }
    if (!(await currentPeer($))) return next(e)
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
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" plain onPress={() => void refresh($)}>{`↻ ${hhmm(data.updated)}`}</Button>
          <Text color={pal.accent}>●</Text>
          <Button key="theme" plain onPress={() => void setTheme($)}>{pal.name}</Button>
        </Box>
      </Box>
    )
    // Under the time: what is going on now, or that all is well.
    const statusRow = (
      <Box width={cols} justifyContent="flex-end">
        <Text wrap="truncate-end" color={status ? pal.accent : undefined} dimColor={!status}>{status || `✓ ${t.ok}`}</Text>
      </Box>
    )
    const footer = status ? <Text dimColor wrap="truncate-end">{status}</Text> : null

    if (pic) { // a picture over the chat: tgview.py draws it on top of this blank box, ✕ (or q) closes
      return (
        <Box flexDirection="column" width={cols}>
          <Box flexDirection="row" justifyContent="flex-end" width={cols}>
            <Button key="close-pic" hotkey="q" onPress={() => void closePicture($)}>✕</Button>
          </Box>
          <Box height={Math.max(4, bodyRows - 2)} />
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

    // The summary's choices, in place of its button: unread, or what was posted in the last day / week / month.
    const summaryMenu = (key: string, onUnread: () => void, onPeriod: (p: Period) => void) => (
      <Box flexDirection="row" gap={1}>
        <Button key={`sum-unread-${key}`} onPress={onUnread}>{t.unreadWord}</Button>
        {PERIODS.map(p => <Button key={`sum-${p}-${key}`} onPress={() => onPeriod(p)}>{t[p]}</Button>)}
        <Button key={`sum-x-${key}`} plain onPress={() => void toggleMenu($, key)}>{t.cancel}</Button>
      </Box>
    )
    const summaryButton = (key: string, open: string | null, onUnread: () => void, onPeriod: (p: Period) => void) =>
      open === key ? summaryMenu(key, onUnread, onPeriod)
        : <Button key={`digest-${key}`} onPress={() => void toggleMenu($, key)}>{`${t.summary} ▾`}</Button>
    const menuOpen = await read($, sumMenu)

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
                  <Box flexDirection="row" gap={1} flexWrap="wrap">
                    <Button key={`folder-${f}`} plain onPress={() => void openFolder($, f)}>
                      {`▸ ${folderTitle(f)} — ${n} ${t.unread}`}
                    </Button>
                    {summaryButton(`f:${f}`, menuOpen, () => void digest($, f, folderTitle(f)), p => void digestPeriod($, { folder: f }, folderTitle(f), p))}
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
    const [peer, history, top, hidden, picked, md, tool, fw, fnd, jumpMid, lq, trAll] = await Promise.all([currentPeer($), read($, chat), read($, listTop), read($, lift),
      read($, sel), read($, mode), read($, toolbar), read($, fwd), read($, found), read($, jump), read($, listQ), read($, trs)])
    const shown = history?.peer === peer ? history : null
    const cached = listed.find(c => c.id === peer)
    const kind: Kind | undefined = shown?.kind ?? cached?.kind
    const title = shown?.title ?? cached?.title
    const writable = !!peer && kind !== 'channel'
    const n = await read($, draft)
    const pickedMsg = picked !== null ? shown?.messages.find(m => m.mid === picked) : undefined // gone from the window (deleted, scrolled out) — nothing is picked

    const folderBar = current === 'channels' && (
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="folders" onPress={() => void openFolder($, null)}>{t.folders}</Button>
        <Text bold color={pal.accent}>{`${folderTitle(openFolderName!)} ${sum(listed)}`}</Text>
        {summaryButton(`f:${openFolderName}`, menuOpen, () => void digest($, openFolderName!, folderTitle(openFolderName!)), p => void digestPeriod($, { folder: openFolderName! }, folderTitle(openFolderName!), p))}
        {sum(listed) > 0 && <Button key="readall" onPress={() => void readAll($, openFolderName!, folderTitle(openFolderName!))}>{t.readAll}</Button>}
      </Box>
    )

    // Height budget: header, gap, [folder bar + gap], boxed input (3), status line, one spare row (so the engine
    // always has something to scroll and keeps raising the wheel for us).
    // Room for three lines of typed text: the field wraps by itself, and a redraw while typing takes the cursor away.
    const inputRows = writable ? 5 : 0
    const boxH = Math.max(7, bodyRows - 2 - (folderBar ? 2 : 0) - inputRows) // the status is under the time, the input is at the very bottom
    const sorted = [...listed].sort(unreadFirst)
    const needle = (lq?.q ?? '').toLowerCase()
    const matched = needle ? sorted.filter(c => c.title.toLowerCase().includes(needle)) : sorted
    const listRows = boxH - 2 - (Input || lq ? 1 : 0) // border, the search row
    const searching = !!lq
    const hits = lq?.hits ?? []
    const chatsShown = searching ? matched.slice(0, hits.length ? Math.max(3, Math.floor(listRows / 2)) : listRows) : matched
    const paged = !searching && chatsShown.length > listRows
    const size = paged ? listRows - 1 : listRows
    const from = Math.min(top, Math.max(0, chatsShown.length - size))
    view.leftWidth = narrow ? (peer ? 0 : cols) : left
    view.listLen = searching ? 0 : chatsShown.length
    view.listFit = size
    const chatButton = (c: CachedChat) => c.id === peer ? ( // the open chat — in the colour its name has in the conversation
      <Text key={`chat-${c.id}`} bold color={senderColor(c.title)}>{chatRow(c, true, left - 3)}</Text>
    ) : (
      <Button key={`chat-${c.id}`} plain dimColor={c.unread === 0 || c.muted}
        onPress={() => void openChat($, c.id, current === 'channels' && opt.autoReadChannels !== false && c.kind === 'channel')}>
        {chatRow(c, false, left - 3)}
      </Button>
    )
    const list = (
      <Box flexDirection="column" width={left} height={boxH} borderStyle="round" borderColor={pal.frame}>
        {searching ? (
          <Button key="list-clear" plain onPress={() => void runListSearch($, '')}>{fit(`⌕ ${lq!.q}`, left - 7) + ` ✕`}</Button>
        ) : Input ? (
          <Input key="list-q" label="⌕" placeholder={t.searchList} submitLabel=" " onSubmit={(value: string) => void runListSearch($, value)} />
        ) : null}
        {chatsShown.slice(searching ? 0 : from, (searching ? 0 : from) + size).map(chatButton)}
        {searching && hits.length > 0 && <Text dimColor>{fit(`── ${t.hitsHead} ──`, left - 2)}</Text>}
        {searching && hits.slice(0, Math.max(0, listRows - Math.min(chatsShown.length, listRows) - 1)).map(hit => (
          <Button key={`hit-${hit.peer}-${hit.mid}`} plain onPress={() => void openChat($, hit.peer, false, hit.mid)}>
            {fit(`${hit.title}: ${hit.text}`, left - 3)}
          </Button>
        ))}
        {searching && !hits.length && chatsShown.length === 0 && <Text dimColor>{lq!.hits === null && lq!.q.length >= 2 ? t.searching : t.nothingFound}</Text>}
        {paged && (
          <Box flexDirection="row" gap={1}>
            {from > 0 && <Button key="list-up" plain onPress={() => void update($, listTop, () => Math.max(0, from - size))}>▲</Button>}
            {from + size < chatsShown.length && <Button key="list-down" plain onPress={() => void update($, listTop, () => from + size)}>▼</Button>}
            <Text dimColor>{`${from + 1}–${Math.min(from + size, chatsShown.length)}/${chatsShown.length}`}</Text>
          </Box>
        )}
      </Box>
    )

    const bar = (m: Row) => m.out ? pal.accent : m.sender ? senderColor(m.sender) : undefined // mine — the theme's accent, others — a colour per name
    const inner = right - 4 // border and padding
    const fitRows = boxH - 3 // border and the title row
    const textW = inner - 9 // bar, space, time
    view.textW = textW
    const texts: Record<number, string> = {}
    for (const [k, v] of Object.entries(trAll)) if (peer && k.startsWith(`${peer}:`)) texts[+k.slice(peer.length + 1)] = v
    const rowsAll = rowsOf(shown, texts)
    view.total = rowsAll.length
    view.fit = fitRows
    const lifted = Math.min(hidden, Math.max(0, rowsAll.length - fitRows))
    const end = rowsAll.length - lifted
    const slice = rowsAll.slice(Math.max(0, end - fitRows), end)
    const step = Math.max(1, fitRows - 2)
    const lit = md ? md.mid : pickedMsg?.mid // the picked message (or the one being answered) is lit
    const back = (m: Row) => (m.mid === undefined ? undefined : m.mid === lit ? pal.frame : m.mid === jumpMid ? '#5a4a12' : undefined)

    // The chat's top row — always exactly one row, so the window never changes height under the pointer:
    // forwarding, search, a reply or an edit in the making, the actions of the picked message, or the title.
    const emojis = ['👍', '❤', '🔥', '🤣', '😢', '🙏', '🤔', '👎'] // all in Telegram's list of reactions
    const topRow = () => {
      if (fw) {
        const to = fw.to ? (data.folders[ALL]?.chats ?? []).find(c => c.id === fw.to) : undefined
        return (
          <Box flexDirection="row" gap={1} width={inner}>
            {to ? <Text wrap="truncate-end" bold color={pal.accent}>{t.fwdAsk(to.title)}</Text> : <Text bold color={pal.accent}>{t.fwdTitle}</Text>}
            {to && <Button key="fwd-yes" variant="primary" onPress={() => void forwardTo($, to.id)}>{t.yes}</Button>}
            <Button key="fwd-x" plain onPress={() => void update($, fwd, old => (old && old.to ? { ...old, to: null } : null))}>{to ? t.no : t.cancel}</Button>
          </Box>
        )
      }
      if (fnd) {
        return fnd.hits === null && fnd.q === '' ? (
          <Box flexDirection="row" gap={1} width={inner}>
            {Input && <Input key="chat-q" autoFocus label="⌕" placeholder={t.searchChat} submitLabel=" " onSubmit={(value: string) => void runSearch($, value)} />}
            <Button key="chat-q-x" plain onPress={() => void update($, found, () => null)}>{t.cancel}</Button>
          </Box>
        ) : (
          <Box flexDirection="row" gap={1} width={inner}>
            <Text wrap="truncate-end" bold color={pal.accent}>{`⌕ ${fnd.q}`}</Text>
            <Text dimColor>{fnd.hits ? (fnd.hits.length ? t.found(fnd.hits.length) : t.nothingFound) : t.searching}</Text>
            <Button key="chat-q-x" plain onPress={() => void update($, found, () => null)}>{t.cancel}</Button>
          </Box>
        )
      }
      if (md) {
        return (
          <Box flexDirection="row" gap={1} width={inner}>
            <Text wrap="truncate-end" bold color={pal.accent}>{md.kind === 'edit' ? t.editing : t.replying(md.text)}</Text>
            <Button key="mode-x" plain onPress={() => void cancelMode($)}>{t.cancel}</Button>
          </Box>
        )
      }
      if (pickedMsg) {
        const mid = pickedMsg.mid
        const compact = inner < 58
        const label = (long: string) => (compact ? long.split(' ')[0]! : long)
        if (tool === 'react') {
          return (
            <Box flexDirection="row" gap={1} width={inner}>
              {emojis.map(em => <Button key={`react-${em}`} plain onPress={() => void reactTo($, mid, em)}>{em}</Button>)}
              <Button key="bar-x" plain onPress={() => void update($, toolbar, () => '')}>{t.cancel}</Button>
            </Box>
          )
        }
        if (tool === 'delete') {
          return (
            <Box flexDirection="row" gap={1} width={inner}>
              <Text bold color={pal.accent}>{t.confirmDel}</Text>
              <Button key="del-yes" variant="primary" onPress={() => void deleteMessage($, mid)}>{t.yes}</Button>
              <Button key="del-no" plain onPress={() => void update($, toolbar, () => '')}>{t.no}</Button>
            </Box>
          )
        }
        return (
          <Box flexDirection="row" gap={1} width={inner}>
            {writable && <Button key="act-reply" plain onPress={() => void startReply($, mid)}>{label(t.reply)}</Button>}
            {writable && pickedMsg.out && <Button key="act-edit" plain onPress={() => void startEdit($, mid)}>{label(t.edit)}</Button>}
            {writable && pickedMsg.out && <Button key="act-del" plain onPress={() => void update($, toolbar, () => 'delete')}>{label(t.del)}</Button>}
            <Button key="act-react" plain onPress={() => void update($, toolbar, () => 'react')}>{label(t.react)}</Button>
            <Button key="act-fwd" plain onPress={() => void startForward($, mid)}>{label(t.forward)}</Button>
            <Button key="act-x" plain onPress={() => void update($, sel, () => null)}>{t.cancel}</Button>
          </Box>
        )
      }
      return (
        <Box flexDirection="row" justifyContent="space-between" width={inner}>
          <Box flexDirection="row" gap={1}>
            {narrow && <Button key="back-list" onPress={() => void closeChat($)}>{t.chats}</Button>}
            <Text bold color={pal.accent} wrap="truncate-end">{title ?? '…'}</Text>
            <Button key="search-chat" plain onPress={() => void openSearch($)}>⌕</Button>
            {kind === 'channel' || kind === 'group' ? summaryButton(`c:${peer}`, menuOpen, () => void digestChat($, peer!, title ?? peer!), p => void digestPeriod($, { peer: peer! }, title ?? peer!, p)) : null}
            {jumpMid !== null && <Button key="to-new" plain onPress={() => void toNewest($)}>{t.toNew}</Button>}
          </Box>
          <Box flexDirection="row" gap={1}>
            <Button key="older" plain onPress={() => void scroll($, step)}>▲</Button>
            <Button key="newer" plain onPress={() => void scroll($, -step)}>▼</Button>
          </Box>
        </Box>
      )
    }

    // What fills the window under the top row: the chats to forward to, the search hits, or the messages.
    const fwdChats = fw ? (data.folders[ALL]?.chats ?? []).filter(c => c.kind !== 'channel' && (!fw.q || c.title.toLowerCase().includes(fw.q.toLowerCase()))) : []
    const body = () => {
      if (fw && !fw.to) {
        return [
          Input && <Input key={`fwd-q-${fw.q}`} autoFocus label="⌕" placeholder={t.fwdFilter} submitLabel=" "
            onSubmit={(value: string) => void update($, fwd, old => (old ? { ...old, q: value.trim() } : old))} />,
          ...fwdChats.slice(0, fitRows - 1).map(c => (
            <Button key={`fwd-${c.id}`} plain onPress={() => void update($, fwd, old => (old ? { ...old, to: c.id } : old))}>{fit(c.title, inner - 1)}</Button>
          )),
          fwdChats.length === 0 && <Text key="fwd-none" dimColor>{t.fwdNone}</Text>,
        ]
      }
      if (fnd?.hits) {
        return fnd.hits.slice(0, fitRows).map(hit => (
          <Button key={`qhit-${hit.mid}`} plain onPress={() => void jumpTo($, hit.mid)}>
            {fit(`${hit.date} ${hit.time}  ${bare(hit) || hit.media || ''}`, inner - 1)}
          </Button>
        ))
      }
      return [
          peer && slice.length === 0 && shown && <Text key="nothing" dimColor>{t.nothingYet}</Text>,
          ...slice.map(m => {
            const bg = back(m)
            const lead = <Text color={bar(m)} backgroundColor={bg} dimColor={!m.out && !m.sender && !bg}>▎ </Text>
            if (m.isDate) return <Box key={m.key} width={inner} justifyContent="center"><Text dimColor>{`── ${m.text} ──`}</Text></Box>
            if (m.head) {
              return (
                <Box key={m.key} flexDirection="row" width={inner}>
                  <Text color={bar(m)} backgroundColor={bg}>▎ </Text>
                  <Text bold wrap="truncate-end" color={bar(m)} backgroundColor={bg}>{m.text}</Text>
                </Box>
              )
            }
            if (m.media || m.trans) {
              return (
                <Box key={m.key} flexDirection="row" width={inner}>
                  {lead}
                  <Button key={m.media ? `media-${m.media.mid}` : `tr-${m.trans!.mid}`} plain
                    onPress={() => void (m.media ? openMedia($, m.media.mid, cols) : transcribe($, m.trans!.mid))}>{m.text}</Button>
                </Box>
              )
            }
            if (m.meta) {
              return (
                <Box key={m.key} flexDirection="row" width={inner}>
                  {lead}
                  <Box width={textW}><Text wrap="truncate-end" dimColor backgroundColor={bg}>{bg ? fit(m.text, textW) : m.text}</Text></Box>
                </Box>
              )
            }
            return (
              <Box key={m.key} flexDirection="row" width={inner}>
                {lead}
                <Box width={textW}>
                  <Button key={`pick-${m.key}`} plain onPress={() => void pickMessage($, m.mid!)}>
                    <Text wrap="truncate-end" color={bar(m)} backgroundColor={bg}>{bg ? fit(m.text, textW) : m.text}</Text>
                  </Button>
                </Box>
                <Box width={6} flexShrink={0} justifyContent="flex-end"><Text dimColor backgroundColor={bg}>{(m.time ?? '') + (m.edited ? '✎' : '')}</Text></Box>
              </Box>
            )
          }),
          lifted > 0 && <Box key="lifted" position="absolute" right={1} bottom={0}><Text dimColor>{`▼ ${lifted}`}</Text></Box>,
      ]
    }
    const msgView = (
      <Box flexDirection="column" width={right} height={boxH} borderStyle="round" borderColor={peer ? pal.accent : pal.frame} paddingX={1}>
        {!peer && <Text dimColor wrap="wrap">{current === 'private' ? t.pickChat : t.pick}</Text>}
        {peer && topRow()}
        {peer && body()}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {header}
        {statusRow}
        {folderBar}
        <Box flexDirection="row" gap={narrow ? 0 : 1}>
          {(!narrow || !peer) && list}
          {(!narrow || peer) && msgView}
        </Box>
        {peer && !writable && <Text dimColor>{t.readOnly}</Text>}
        {writable && (
          <Box borderStyle="round" borderColor={pal.accent} paddingX={1} width={cols}>
            {Input ? <Input key={`msg-${n}`} autoFocus rows={3} label={`${md?.kind === 'reply' ? '↪' : md?.kind === 'edit' ? '✎' : '→'} ${(title ?? '').slice(0, 20)}`}
              {...(md?.kind === 'edit' ? { value: md.text } : {})}
              placeholder={t.placeholder} submitLabel=" "
              onSubmit={(value: string) => void send($, value)} /> : <Text dimColor>{t.terminalOnly}</Text>}
          </Box>
        )}
      </Box>
    )
  })
}
