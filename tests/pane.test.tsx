import { expect, mock, test } from 'claude-code/testing'
import { isDoublePress, layoutMessages, wrapLines } from '../hooks/register'

const CACHE = {
  updated: 1759750000,
  order: ['Личные', 'Interesting', '@all'],
  folders: {
    Личные: { updated: 1759750000, unread: 3, chats: [
      { id: '111', title: 'Anna', kind: 'user', time: '16:00', last: 'привет', unread: 3, muted: false },
      { id: '222', title: 'Боря', kind: 'user', time: '15:00', last: 'ок', unread: 0, muted: false },
    ] },
    Interesting: { updated: 1759750000, unread: 9, chats: [
      { id: '-5', title: 'Markets News', kind: 'channel', time: '09:00', last: 'пост', unread: 7, muted: true },
      { id: '-6', title: 'Чат клуба', kind: 'group', time: '08:00', last: 'привет всем', unread: 2, muted: false },
    ] },
    '@all': { updated: 1759750000, unread: 12, chats: [
      { id: '111', title: 'Anna', kind: 'user', time: '16:00', last: 'привет', unread: 3, muted: false },
      { id: '-5', title: 'Markets News', kind: 'channel', time: '09:00', last: 'пост', unread: 7, muted: true },
    ] },
  },
}
const KIND: Record<string, string> = { '111': 'user', '-5': 'channel', '-6': 'group' }
const HISTORY = (peer: string, from = 1) => ({ peer, title: peer === '111' ? 'Anna' : 'Markets News', kind: KIND[peer],
  unread: 0, messages: Array.from({ length: 40 }, (_, i) => ({ mid: from + i, date: '8.10', time: '16:00', out: false, text: `сообщение ${from + i}` })) })
const PANE = { component: 'Pane', requestId: 'telegram', viewport: { columns: 100, rows: 30 },
  props: { title: 'Telegram', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 28 }, view: {} } } as const
const RU = { options: { language: 'ru', privateFolder: 'Личные', python: '/py', timezone: 'Europe/Moscow' } }
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as any

// Answers the backend: history for tgchat.py (older messages for --before), «ok» for everything else.
function backend(on: any, runs: string[][], answer?: (argv: string[]) => any, opens: string[] = [], store: Record<string, unknown> = {}) {
  mock.clock(on)
  mock.store(on, store)
  mock.env(on, { HOME: '/home/x' })
  on('fs.read', async () => ({ value: JSON.stringify(CACHE) }) as any)
  on('ui.open', async (_: any, e: any) => { opens.push(e.id); return { value: { isPlaced: true } } as any })
  on('process.run', async (_: any, e: any) => {
    const argv = [...e.argv] as string[]
    runs.push(argv)
    const custom = answer?.(argv)
    if (custom) return custom
    if (argv[1]!.endsWith('tgchat.py')) return ok(JSON.stringify(HISTORY(argv[2]!, argv.includes('--before') ? -39 : 1)))
    return ok('sent')
  })
}
const script = (a: string[]) => a.slice(1).map(x => x.replace(/^.*\/backend\//, ''))

test('private: a chat is read without «read», Enter sends exactly the typed text', RU, async ($, on) => {
  const runs: string[][] = []
  backend(on, runs)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })

  expect(await ui.find({ type: 'Button', text: /Anna \(3\)/ })).toBeDefined()
  expect(runs.map(script)).toEqual([['tgcache.py']]) // on open — counters only, no chat
  expect(runs[0]![0]).toBe('/py')

  await ui.press({ key: 'chat-111' })
  expect(script(runs[1]!)).toEqual(['tgchat.py', '111', '40'])
  expect(await ui.find({ type: 'Text', text: /сообщение 40/ })).toBeDefined()

  await ui.input({ key: 'msg-0', text: 'всё хорошо' })
  expect(script(runs[2]!)).toEqual(['tgmsg.py', '--peer', '111', 'всё хорошо'])
  await ui.unmount()
})

test('channels: folders → a folder → a channel (marked read on open) → its summary; back to folders', RU, async ($, on) => {
  const runs: string[][] = []
  const prompts: string[] = []
  backend(on, runs)
  on('prompt.submit', async (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('ui.toast', async () => ({ value: undefined }) as any)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })

  await ui.press({ key: 'tab-channels' })
  expect(await ui.find({ type: 'Button', text: /Interesting — 9/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Markets News 7 · Чат клуба 2/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Личные/ })).toBeDefined() // the tab, not a folder row
  await ui.press({ key: 'digest-f:Interesting' }) // «Summary» opens its choices: unread, day, week, month
  await ui.press({ key: 'sum-unread-f:Interesting' })
  expect(prompts[0]).toContain('tgunread.py "Interesting"')
  expect(prompts[0]).not.toContain('--since')
  await ui.press({ key: 'digest-f:Interesting' })
  await ui.press({ key: 'sum-week-f:Interesting' })
  expect(prompts[1]).toContain('tgunread.py "Interesting" --since week')

  await ui.press({ key: 'folder-Interesting' })
  expect(await ui.find({ type: 'Button', text: /Markets News \(7\)/ })).toBeDefined()
  await ui.press({ key: 'chat--5' })
  expect(script(runs.at(-1)!)).toEqual(['tgchat.py', '-5', '40', '--read'])
  expect(await ui.find({ type: 'Text', text: /^сообщение 40/ })).toBeDefined() // a channel: no «←», the time apart
  expect(await ui.find({ type: 'Text', text: /только чтение/ })).toBeDefined()

  await ui.press({ key: 'chat--6' }) // a group: opened without «read», can be written to
  expect(script(runs.at(-1)!)).toEqual(['tgchat.py', '-6', '40'])
  expect(await ui.find({ type: 'Input', key: 'msg-0' })).toBeDefined()

  await ui.press({ key: 'digest-c:-6' })
  await ui.press({ key: 'sum-unread-c:-6' })
  expect(prompts[2]).toContain('tgunread.py --peer -6')
  await ui.press({ key: 'digest-c:-6' })
  await ui.press({ key: 'sum-day-c:-6' })
  expect(prompts[3]).toContain('tgunread.py --peer -6 --since day')

  await ui.press({ key: 'readall' })
  expect(script(runs.at(-1)!)).toEqual(['tgunread.py', 'Interesting', '--mark-only'])

  await ui.press({ key: 'folders' })
  expect(await ui.find({ type: 'Button', key: 'folder-Interesting' })).toBeDefined()
  await ui.unmount()
})

test('no private folder set: «Private» lists people from all chats, «Categories» the folders', { options: { python: '/py', timezone: 'UTC' } }, async ($, on) => {
  backend(on, [])
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Button', text: /Private 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'chat-111' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'chat--5' })).toBeUndefined()
  await ui.press({ key: 'tab-channels' })
  expect(await ui.find({ type: 'Button', key: 'folder-Личные' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'folder-@all' })).toBeDefined() // «All chats» comes first
  await ui.unmount()
})

test('older messages: «▲» loads the page before the oldest one', RU, async ($, on) => {
  const runs: string[][] = []
  backend(on, runs)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'chat-111' })
  for (let i = 0; i < 3; i++) await ui.press({ key: 'older' })
  expect(runs.some(a => script(a).join(' ') === 'tgchat.py 111 40 --before 1')).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'newer' })).toBeDefined()
  await ui.unmount()
})

test('narrow pane: the list, then the chat with «← Chats»', RU, async ($, on) => {
  backend(on, [])
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 40 } })
  await ui.press({ key: 'chat-111' })
  expect(await ui.find({ type: 'Button', key: 'chat-222' })).toBeUndefined()
  await ui.press({ key: 'back-list' })
  expect(await ui.find({ type: 'Button', key: 'chat-222' })).toBeDefined()
  await ui.unmount()
})

test('not logged in: the QR code to scan; a stopped browser gets «Start»', RU, async ($, on) => {
  const runs: string[][] = []
  let state = 'qr'
  backend(on, runs, argv => {
    if (argv[1]!.endsWith('tgcache.py')) return { value: { exitCode: 77, stdout: '', stderr: 'not logged in', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[2] === 'status') return ok(JSON.stringify(state === 'qr' ? { running: true, state, qr: Array(25).fill('1010101010101010101010101') } : { running: false, state }))
  })
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Raster', key: 'qr' })).toBeDefined()

  state = 'down'
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'start' })
  expect(runs.some(a => script(a).join(' ') === 'tgbrowser.py start')).toBe(true)
  await ui.unmount()
})

test('FLOOD_WAIT pauses; a browser that does not answer is restarted', RU, async ($, on) => {
  const runs: string[][] = []
  let fail: any = null
  backend(on, runs, argv => (fail && !argv.includes('start') ? fail : undefined))
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })

  fail = { value: { exitCode: 75, stdout: '', stderr: 'FLOOD_WAIT_30', isStdoutTruncated: false, isStderrTruncated: false } }
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /притормозить/ })).toBeDefined()

  fail = { value: { exitCode: 76, stdout: '', stderr: 'does not answer', isStdoutTruncated: false, isStderrTruncated: false } }
  await ui.press({ key: 'refresh' })
  expect(runs.some(a => script(a).join(' ') === 'tgbrowser.py start')).toBe(true)
  await ui.unmount()
})

test('/clear: the open chat and tab survive the new session', RU, async ($, on) => {
  const opens: string[] = []
  backend(on, [], undefined, opens)
  on('ui.panes', async () => ({ value: [] }) as any) // /clear closed the pane
  on('session.end', async () => ({ sessionId: 'old' }) as any)
  on('classic.SessionStart', async () => ({}) as any)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'chat-111' })
  await $.session.end({ reason: 'clear', sessionId: 'old' } as any)
  await $.classic.SessionStart({ source: 'clear' } as any)
  expect(opens).toEqual(['telegram', 'telegram']) // opened again
  expect(await ui.find({ type: 'Text', text: /сообщение 40/ })).toBeDefined()
  await ui.unmount()
})

test('restart: the pane opens where it was left (from the store)', RU, async ($, on) => {
  const runs: string[][] = []
  backend(on, runs, undefined, [], { place: { tab: 'channels', selected: null, channel: '-6', folder: 'Interesting' } })
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  expect(runs.some(a => script(a).join(' ') === 'tgchat.py -6 40')).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'folders' })).toBeDefined()
  await ui.unmount()
})

test('a group shows who wrote; «Private» has no summary, a chat there has search instead of «read»', RU, async ($, on) => {
  backend(on, [], argv => argv[1]!.endsWith('tgchat.py') && argv[2] === '-6' ? ok(JSON.stringify({ peer: '-6', title: 'Чат клуба', kind: 'group', unread: 0,
    messages: [{ mid: 1, date: '8.10', time: '12:00', out: false, from: 'Петя', text: 'кто на тренировку?' }] })) : undefined)
  on('prompt.submit', async (_, e) => ({ text: e.text }))
  on('ui.toast', async () => ({ value: undefined }) as any)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Button', key: 'digest-private' })).toBeUndefined()
  await ui.press({ key: 'chat-111' })
  expect(await ui.find({ type: 'Button', key: 'digest-chat' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'mark-read' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'search-chat' })).toBeDefined()
  await ui.press({ key: 'tab-channels' })
  expect(await ui.find({ type: 'Button', text: /Категории/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'folder-@all' })).toBeDefined()
  await ui.press({ key: 'folder-Interesting' })
  await ui.press({ key: 'chat--6' })
  expect(await ui.find({ type: 'Text', text: /^Петя$/ })).toBeDefined() // the name on its own row
  expect(await ui.find({ type: 'Text', text: /кто на тренировку\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^12:00$/ })).toBeDefined()
  await ui.unmount()
})

test('no time zone known: the pane asks, the answer is kept', { options: { python: '/py', language: 'ru' } }, async ($, on) => {
  const store: Record<string, unknown> = {}
  backend(on, [], undefined, [], store)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  if (await ui.find({ type: 'Button', key: 'tz-Europe/Moscow' })) { // the test machine's zone may be a real one — then no question
    await ui.press({ key: 'tz-Europe/Moscow' })
  }
  expect(await ui.find({ type: 'Button', key: 'tab-private' })).toBeDefined()
  await ui.unmount()
})

test('a long message is shown whole, wrapped; a picture gets an «open» row', () => {
  const long = Array.from({ length: 60 }, (_, i) => `слово${i}`).join(' ')
  const lines = wrapLines(long, 30)
  expect(lines.length).toBeGreaterThan(8)
  expect(lines.join(' ')).toBe(long) // nothing cut
  expect(Math.max(...lines.map(l => l.length))).toBeLessThanOrEqual(30)
  const rows = layoutMessages([
    { mid: 1, date: '19.10', time: '10:00', out: false, text: 'a' },
    { mid: 2, date: '20.10', time: '11:00', out: true, text: '[media] фото', media: 'photo' },
  ], 30, k => `open ${k}`)
  expect(rows.filter(r => r.isDate).map(r => r.text)).toEqual(['19.10', '20.10'])
  expect(rows.at(-1)).toMatchObject({ media: { mid: 2, kind: 'photo' }, text: 'open photo' })
  expect(rows.find(r => r.time === '11:00')?.text).toBe('фото')
})

test('theme button cycles the colour and is kept; the picture button downloads on request', RU, async ($, on) => {
  const runs: string[][] = []
  const store: Record<string, unknown> = {}
  backend(on, runs, argv => argv[1]!.endsWith('tgchat.py') && argv[2] === '111' ? ok(JSON.stringify({ peer: '111', title: 'Anna', kind: 'user', unread: 0,
    messages: [{ mid: 7, date: '20.10', time: '12:00', out: false, text: '[media] ', media: 'photo' }] }))
    : argv[1]!.endsWith('tgmedia.py') ? ok('/data/media/111_7.png\n') : undefined, [], store)
  on('ui.toast', async () => ({ value: undefined }) as any)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'theme' })
  expect(await ui.find({ type: 'Button', text: /violet/ })).toBeDefined()
  await ui.press({ key: 'chat-111' })
  expect(runs.some(r => r[1]!.endsWith('tgmedia.py'))).toBe(false) // nothing downloaded until asked
  await ui.press({ key: 'media-7' })
  expect(script(runs.find(r => r[1]!.endsWith('tgmedia.py'))!)).toEqual(['tgmedia.py', '111', '7'])
  expect(script(runs.find(r => r[1]!.endsWith('tgview.py'))!).slice(0, 2)).toEqual(['tgview.py', 'show']) // drawn by Kitty graphics
  expect(await ui.find({ key: 'close-pic' })).toBeDefined() // the pane is a blank box with ✕
  await ui.press({ key: 'close-pic' })
  expect(runs.some(r => r[1]!.endsWith('tgview.py') && r[2] === 'clear')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Anna/ })).toBeDefined() // closed — the chat is back (its row in the list is now text)
  await ui.unmount()
})

// ---- v0.5: picking a message, reply, edit, delete, reaction, forward, search, transcripts

const MINE = JSON.stringify({ peer: '111', title: 'Anna', kind: 'user', unread: 0, messages: [
  { mid: 5, date: '20.10', time: '12:00', out: false, text: 'привет' },
  { mid: 6, date: '20.10', time: '12:01', out: true, text: 'моё сообщение' },
  { mid: 7, date: '20.10', time: '12:02', out: false, text: '[media] ', media: 'voice' },
  { mid: 8, date: '20.10', time: '12:03', out: false, text: 'с реакцией', reactions: [{ e: '👍', n: 2, me: true }], reply: { mid: 5, text: 'привет' } },
] })
const withChat = (extra?: (argv: string[]) => any) => (argv: string[]) => {
  const custom = extra?.(argv)
  if (custom) return custom
  return argv[1]!.endsWith('tgchat.py') && argv[2] === '111' && !argv.includes('--query') && !argv.includes('--around') ? ok(MINE) : undefined
}
async function open(on: any, runs: string[][], extra?: (argv: string[]) => any) {
  backend(on, runs, withChat(extra))
  on('ui.toast', async () => ({ value: undefined }) as any)
}

test('two presses within a moment are a double press, a slow one is not', () => {
  expect(isDoublePress({ mid: 5, at: 1000 }, 5, 1300)).toBe(true)
  expect(isDoublePress({ mid: 5, at: 1000 }, 5, 1600)).toBe(false)
  expect(isDoublePress({ mid: 5, at: 1000 }, 6, 1100)).toBe(false)
})

test('one press picks a message and shows its actions; only my own can be edited or deleted', RU, async ($, on) => {
  const runs: string[][] = []
  await open(on, runs)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'chat-111' })
  expect(await ui.find({ type: 'Button', key: 'act-fwd' })).toBeUndefined() // nothing picked: the title row
  await ui.press({ key: 'pick-m5-0' })
  expect(await ui.find({ type: 'Button', key: 'act-fwd' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'act-react' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'act-edit' })).toBeUndefined() // not mine
  expect(await ui.find({ type: 'Button', key: 'act-del' })).toBeUndefined()
  await ui.press({ key: 'pick-m6-0' })
  expect(await ui.find({ type: 'Button', key: 'act-edit' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'act-del' })).toBeDefined()
  await ui.press({ key: 'act-x' })
  expect(await ui.find({ type: 'Button', key: 'act-fwd' })).toBeUndefined()
  await ui.unmount()
})

test('a reply goes out as an answer to the picked message', RU, async ($, on) => {
  const runs: string[][] = []
  await open(on, runs)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'chat-111' })
  await ui.press({ key: 'pick-m5-0' })
  await ui.press({ key: 'act-reply' })
  expect(await ui.find({ type: 'Button', key: 'mode-x' })).toBeDefined() // «↪ ответ: …» with ✕ in the top row
  await ui.input({ key: 'msg-0', text: 'отвечаю' })
  expect(runs.some(a => script(a).join('|') === 'tgmsg.py|--peer|111|--reply|5|отвечаю')).toBe(true)
  await ui.unmount()
})

test('delete asks first and deletes only on «yes»; a reaction and a forward go through tgact.py', RU, async ($, on) => {
  const runs: string[][] = []
  await open(on, runs)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'chat-111' })
  const acts = () => runs.filter(r => r[1]!.endsWith('tgact.py')).map(script)

  await ui.press({ key: 'pick-m6-0' })
  await ui.press({ key: 'act-del' })
  await ui.press({ key: 'del-no' })
  expect(acts()).toEqual([])
  await ui.press({ key: 'act-del' })
  await ui.press({ key: 'del-yes' })
  expect(acts()).toEqual([['tgact.py', 'delete', '111', '6']])
  expect(await ui.find({ type: 'Button', key: 'pick-m6-0' })).toBeUndefined() // gone from the window

  await ui.press({ key: 'pick-m5-0' })
  await ui.press({ key: 'act-react' })
  await ui.press({ key: 'react-👍' })
  expect(acts().at(-1)).toEqual(['tgact.py', 'react', '111', '5', '👍'])

  await ui.press({ key: 'pick-m8-0' }) // (the test clock stands still: the same message twice would be a double press)
  await ui.press({ key: 'pick-m5-0' })
  await ui.press({ key: 'act-fwd' })
  await ui.press({ key: 'fwd-111' }) // choosing a chat does not send yet…
  expect(acts().at(-1)![1]).toBe('react')
  await ui.press({ key: 'fwd-yes' }) // …the question does
  expect(acts().at(-1)).toEqual(['tgact.py', 'forward', '111', '5', '111'])
  await ui.unmount()
})

test('edit puts my text in the field and sends the new one through tgact.py', RU, async ($, on) => {
  const runs: string[][] = []
  await open(on, runs)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'chat-111' })
  await ui.press({ key: 'pick-m6-0' })
  await ui.press({ key: 'act-edit' })
  const field = await ui.find({ type: 'Input', key: 'msg-1' })
  expect(field).toBeDefined()
  await ui.input({ key: 'msg-1', text: 'исправил' })
  expect(runs.some(a => script(a).join('|') === 'tgact.py|edit|111|6|исправил')).toBe(true)
  expect(runs.some(a => a[1]!.endsWith('tgmsg.py'))).toBe(false) // an edit is not a new message
  await ui.unmount()
})

test('search in a chat: hits, then a window around the chosen one; «to newest» returns', RU, async ($, on) => {
  const runs: string[][] = []
  await open(on, runs, argv => {
    if (!argv[1]!.endsWith('tgchat.py')) return undefined
    if (argv.includes('--query')) return ok(JSON.stringify({ peer: '111', title: 'Anna', kind: 'user', messages: [{ mid: 3, date: '1.10', time: '09:00', out: false, text: 'про кофе' }] }))
    if (argv.includes('--around')) return ok(JSON.stringify({ peer: '111', title: 'Anna', kind: 'user', messages: [{ mid: 2, date: '1.10', time: '08:59', out: false, text: 'до' }, { mid: 3, date: '1.10', time: '09:00', out: false, text: 'про кофе' }] }))
  })
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'chat-111' })
  await ui.press({ key: 'search-chat' })
  await ui.input({ key: 'chat-q', text: 'кофе' })
  expect(runs.some(a => script(a).join('|') === 'tgchat.py|111|30|--query|кофе')).toBe(true)
  await ui.press({ key: 'qhit-3' })
  expect(runs.some(a => script(a).join('|') === 'tgchat.py|111|40|--around|3')).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'to-new' })).toBeDefined()
  await ui.press({ key: 'to-new' })
  expect(await ui.find({ type: 'Button', key: 'to-new' })).toBeUndefined()
  await ui.unmount()
})

test('search above the chat list: chat names, then messages from Telegram', RU, async ($, on) => {
  const runs: string[][] = []
  await open(on, runs, argv => argv[1]!.endsWith('tgsearch.py')
    ? ok(JSON.stringify({ hits: [{ peer: '222', title: 'Боря', mid: 9, date: '2.10', time: '10:00', out: false, text: 'встречаемся у метро' }] })) : undefined)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.input({ key: 'list-q', text: 'метро' })
  expect(script(runs.find(a => a[1]!.endsWith('tgsearch.py'))!)).toEqual(['tgsearch.py', 'метро', '15'])
  expect(await ui.find({ type: 'Button', key: 'chat-111' })).toBeUndefined() // no chat is named «метро»
  await ui.press({ key: 'hit-222-9' })
  expect(runs.some(a => script(a).join('|') === 'tgchat.py|222|40|--around|9')).toBe(true)
  await ui.press({ key: 'list-clear' })
  expect(await ui.find({ type: 'Button', key: 'chat-111' })).toBeDefined()
  await ui.unmount()
})

test('a voice message is transcribed on request and the text stays under it', RU, async ($, on) => {
  const runs: string[][] = []
  await open(on, runs, argv => (argv[1]!.endsWith('tgact.py') && argv[2] === 'transcribe' ? ok('текст голосового\n') : undefined))
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'chat-111' })
  expect(runs.some(a => a[1]!.endsWith('tgact.py'))).toBe(false) // nothing is asked for until the button
  await ui.press({ key: 'tr-7' })
  expect(script(runs.find(a => a[1]!.endsWith('tgact.py'))!)).toEqual(['tgact.py', 'transcribe', '111', '7'])
  expect(await ui.find({ type: 'Text', text: /текст голосового/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'tr-7' })).toBeUndefined()
  await ui.unmount()
})

test('layout: what a message answers, reactions and a transcript are quiet rows of that message', () => {
  const rows = layoutMessages([
    { mid: 1, date: '1.1', time: '10:00', out: false, text: 'ответ', reply: { mid: 0, text: 'вопрос' }, fwd: 'Иван', reactions: [{ e: '👍', n: 2, me: true }, { e: '🔥', n: 1, me: false }] },
    { mid: 2, date: '1.1', time: '10:01', out: false, text: '[media] ', media: 'voice' },
  ], 30, k => `label ${k}`, undefined, { 2: 'расшифровка' })
  expect(rows.filter(r => r.mid === 1 && r.meta).map(r => r.text)).toEqual(['↩ вопрос', '↪ Иван', '[👍 2]  🔥 1'])
  expect(rows.filter(r => r.mid === 1 && r.line)).toHaveLength(1)
  expect(rows.some(r => r.trans)).toBe(false) // the transcript is there, no button
  expect(rows.filter(r => r.mid === 2 && r.meta).map(r => r.text)).toEqual(['♪ расшифровка'])
  const idle = layoutMessages([{ mid: 2, date: '1.1', time: '10:01', out: false, text: '[media] ', media: 'round' }], 30, k => `label ${k}`)
  expect(idle.find(r => r.trans)).toMatchObject({ trans: { mid: 2, kind: 'round' }, text: 'label round' })
})

test('every ✕ of the top row lets go: reply, edit, reaction choice, forward, delete question', RU, async ($, on) => {
  const runs: string[][] = []
  await open(on, runs)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'chat-111' })
  const title = () => ui.find({ type: 'Button', key: 'search-chat' }) // the title row is back
  await ui.press({ key: 'pick-m6-0' })
  await ui.press({ key: 'act-reply' })
  expect(await title()).toBeUndefined()
  await ui.press({ key: 'mode-x' })
  expect(await title()).toBeDefined()

  await ui.press({ key: 'pick-m8-0' })
  await ui.press({ key: 'pick-m6-0' })
  await ui.press({ key: 'act-edit' })
  await ui.press({ key: 'mode-x' })
  expect(await title()).toBeDefined()
  expect(await ui.find({ type: 'Input', key: 'msg-2' })).toBeDefined() // the field is empty again (a new one)

  await ui.press({ key: 'pick-m8-0' })
  await ui.press({ key: 'act-react' })
  await ui.press({ key: 'bar-x' })
  expect(await ui.find({ type: 'Button', key: 'act-react' })).toBeDefined()
  await ui.press({ key: 'act-fwd' })
  await ui.press({ key: 'fwd-x' })
  expect(await ui.find({ type: 'Button', key: 'act-react' })).toBeDefined()
  await ui.press({ key: 'act-fwd' })
  await ui.press({ key: 'fwd-111' })
  await ui.press({ key: 'fwd-x' }) // from the question back to the list of chats
  expect(await ui.find({ type: 'Button', key: 'fwd-111' })).toBeDefined()
  await ui.press({ key: 'fwd-x' })
  await ui.press({ key: 'pick-m6-0' })
  await ui.press({ key: 'act-del' })
  await ui.press({ key: 'del-no' })
  expect(await ui.find({ type: 'Button', key: 'act-del' })).toBeDefined()
  expect(runs.some(r => r[1]!.endsWith('tgact.py'))).toBe(false) // nothing was done to Telegram
  await ui.unmount()
})

test('the bottom of a window around a found message loads what came after it', RU, async ($, on) => {
  const runs: string[][] = []
  const two = JSON.stringify({ peer: '111', title: 'Anna', kind: 'user', messages: [{ mid: 2, date: '1.10', time: '08:59', out: false, text: 'до' }, { mid: 3, date: '1.10', time: '09:00', out: false, text: 'кофе' }] })
  await open(on, runs, argv => (argv[1]!.endsWith('tgchat.py') && (argv.includes('--around') || argv.includes('--query')) ? ok(two) : undefined))
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'chat-111' })
  await ui.press({ key: 'search-chat' })
  await ui.input({ key: 'chat-q', text: 'кофе' })
  await ui.press({ key: 'qhit-3' })
  expect(runs.some(a => a.includes('--around'))).toBe(true)
  await ui.press({ key: 'newer' })
  expect(runs.some(a => script(a).join('|') === 'tgchat.py|111|40|--after|3')).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'to-new' })).toBeUndefined() // reached the newest: live again
  await ui.unmount()
})

test('a failed transcript says so and the button stays; a narrow pane keeps the actions', RU, async ($, on) => {
  const runs: string[][] = []
  await open(on, runs, argv => (argv[1]!.endsWith('tgact.py') ? { value: { exitCode: 1, stdout: '', stderr: 'transcription failed: PREMIUM_ACCOUNT_REQUIRED', isStdoutTruncated: false, isStderrTruncated: false } } : undefined))
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 50 } })
  await ui.press({ key: 'chat-111' })
  await ui.press({ key: 'tr-7' })
  expect(await ui.find({ type: 'Text', text: /Premium/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'tr-7' })).toBeDefined()
  await ui.press({ key: 'pick-m6-0' })
  expect(await ui.find({ type: 'Button', key: 'act-react' })).toBeDefined() // the row of actions with short labels
  await ui.unmount()
})
