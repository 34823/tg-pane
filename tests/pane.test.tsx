import { expect, mock, test } from 'claude-code/testing'
import { layoutMessages, wrapLines } from '../hooks/register'

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
  await ui.press({ key: 'digest-Interesting' })
  expect(prompts[0]).toContain('tgunread.py "Interesting"')

  await ui.press({ key: 'folder-Interesting' })
  expect(await ui.find({ type: 'Button', text: /Markets News \(7\)/ })).toBeDefined()
  await ui.press({ key: 'chat--5' })
  expect(script(runs.at(-1)!)).toEqual(['tgchat.py', '-5', '40', '--read'])
  expect(await ui.find({ type: 'Text', text: /^сообщение 40/ })).toBeDefined() // a channel: no «←», the time apart
  expect(await ui.find({ type: 'Text', text: /только чтение/ })).toBeDefined()

  await ui.press({ key: 'chat--6' }) // a group: opened without «read», can be written to
  expect(script(runs.at(-1)!)).toEqual(['tgchat.py', '-6', '40'])
  expect(await ui.find({ type: 'Input', key: 'msg-0' })).toBeDefined()

  await ui.press({ key: 'digest-chat' })
  expect(prompts[1]).toContain('tgunread.py --peer -6')

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

test('a group shows who wrote; «Private» has a summary that marks nothing read', RU, async ($, on) => {
  const prompts: string[] = []
  backend(on, [], argv => argv[1]!.endsWith('tgchat.py') && argv[2] === '-6' ? ok(JSON.stringify({ peer: '-6', title: 'Чат клуба', kind: 'group', unread: 0,
    messages: [{ mid: 1, date: '8.10', time: '12:00', out: false, from: 'Петя', text: 'кто на тренировку?' }] })) : undefined)
  on('prompt.submit', async (_, e) => { prompts.push(e.text); return { text: e.text } })
  on('ui.toast', async () => ({ value: undefined }) as any)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'digest-private' })
  expect(prompts[0]).toContain('tgunread.py "Личные"')
  expect(prompts[0]).toContain('НЕ')
  await ui.press({ key: 'chat-111' })
  await ui.press({ key: 'digest-chat' })
  expect(prompts[1]).toContain('tgunread.py --peer 111 --private')
  await ui.press({ key: 'tab-channels' })
  expect(await ui.find({ type: 'Button', text: /Категории/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'folder-@all' })).toBeDefined()
  await ui.press({ key: 'folder-Interesting' })
  await ui.press({ key: 'chat--6' })
  expect(await ui.find({ type: 'Text', text: /Петя: кто на тренировку\?/ })).toBeDefined()
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
    : argv[1]!.endsWith('tgmedia.py') ? ok('/data/media/111_7.png\n') : argv[1]!.endsWith('tgcells.py') ? ok(JSON.stringify({ columns: 2, rows: 1, cells: 'gCUAAAAAAAAAAAAAgCUAAAAAAAAAAAAA' })) : undefined, [], store)
  on('ui.toast', async () => ({ value: undefined }) as any)
  await $.command.run({ command: 'tg-pane', args: '', origin: { kind: 'user' } } as any)
  const ui = await $.ui.mount({ plugin: 'tg-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'theme' })
  expect(await ui.find({ type: 'Button', text: /violet/ })).toBeDefined()
  await ui.press({ key: 'chat-111' })
  expect(runs.some(r => r[1]!.endsWith('tgmedia.py'))).toBe(false) // nothing downloaded until asked
  await ui.press({ key: 'media-7' })
  expect(script(runs.find(r => r[1]!.endsWith('tgmedia.py'))!)).toEqual(['tgmedia.py', '111', '7'])
  expect(await ui.find({ type: 'Raster' })).toBeDefined() // the picture over the chat
  await ui.press({ key: 'close-pic' })
  expect(await ui.find({ type: 'Button', key: 'chat-111' })).toBeDefined() // closed — the chat is back
  await ui.unmount()
})
