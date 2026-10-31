#!/usr/bin/env python3
"""Standalone TG Pane. Uses the same backend as the Claude plugin; no model or agent needed."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import curses
import json
import locale
import os
from pathlib import Path
import subprocess
import sys
import time
import unicodedata
from typing import Any

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('TG_PANE_DATA', '~/.local/share/tg-pane')).expanduser()


def clean(value):
    # Telegram text is untrusted terminal input. Keep newlines, never terminal controls.
    return ''.join(c for c in str(value) if c == '\n' or not unicodedata.category(c).startswith('C'))


def cell_width(c):
    return 0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in ('W', 'F') else 1


def fit(text, width):
    out, used = [], 0
    for c in clean(text).replace('\n', ' '):
        n = cell_width(c)
        if used + n > width:
            break
        out.append(c)
        used += n
    return ''.join(out)


def wrap(text, width):
    lines = []
    for paragraph in clean(text).split('\n'):
        line, used = '', 0
        for c in paragraph:
            n = cell_width(c)
            if used + n > max(2, width):
                lines.append(line)
                line, used = '', 0
            line += c
            used += n
        lines.append(line)
    return lines


def backend(script, *args):
    return subprocess.run([sys.executable, str(ROOT / 'backend' / script), *map(str, args)],
                          capture_output=True, text=True, timeout=150)


class Pane:
    def __init__(self, screen, fixture=None):
        self.screen = screen
        self.demo = fixture is not None
        self.cache = fixture or self.load_cache()
        self.view = 'folders'
        self.folder = ''
        self.chat = None
        self.history = {}
        self.index = self.offset = 0
        self.query = ''
        self.status = 'Обновление…'
        self.draft = ''
        self.mode = ''
        self.confirm = None
        self.reply = 0
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.pending = None
        self.last_refresh = self.pause_until = self.last_start = 0
        self.targets = []
        self.message_rows = []
        self.manual_scroll = False
        self.tab = 'categories'
        self.theme = 0
        self.colors = False
        if not self.demo:
            try:
                self.theme = int(json.loads((DATA / 'terminal-ui.json').read_text()).get('theme', 0)) % 5
            except (OSError, ValueError, TypeError):
                pass

    def palette(self):
        if not self.colors:
            return
        accents = [81, 141, 84, 221, 211] if curses.COLORS >= 256 else [6, 5, 2, 3, 1]
        curses.init_pair(1, accents[self.theme], -1)
        curses.init_pair(2, 245 if curses.COLORS >= 256 else 7, -1)
        curses.init_pair(3, 0, accents[self.theme])

    def style(self, role='accent'):
        return curses.color_pair({'accent': 1, 'muted': 2, 'selected': 3}[role]) if self.colors else (curses.A_REVERSE if role == 'selected' else 0)

    def switch_tab(self, tab):
        if self.pending:
            return
        self.tab = tab
        self.view = 'chats' if tab == 'private' else 'folders'
        self.folder = 'Личные' if tab == 'private' else ''
        self.index = self.offset = self.reply = 0
        self.query = self.draft = self.mode = ''
        self.chat = None

    def cycle_theme(self):
        self.theme = (self.theme + 1) % 5
        self.palette()
        if not self.demo:
            try:
                DATA.mkdir(parents=True, exist_ok=True)
                (DATA / 'terminal-ui.json').write_text(json.dumps({'theme': self.theme}))
            except OSError:
                self.status = 'Тема изменена, но не сохранена'

    def load_cache(self):
        try:
            return json.loads((DATA / 'tg-counts.json').read_text())
        except (OSError, ValueError):
            return {'folders': {}}

    def items(self) -> list[Any]:
        if self.view == 'folders':
            folders = self.cache.get('folders', {})
            return [n for n in dict.fromkeys(['@all', *self.cache.get('order', folders)]) if n in folders]
        if self.view == 'chats':
            folders = self.cache.get('folders', {})
            chats = folders.get(self.folder, {}).get('chats', [])
            if self.tab == 'private' and 'Личные' not in folders:
                chats = [c for c in folders.get('@all', {}).get('chats', []) if c.get('kind') == 'user']
            return [c for c in chats if self.query.casefold() in c.get('title', '').casefold()]
        return self.history.get('messages', [])

    def submit(self, script, args=(), purpose='refresh'):
        if self.pending or self.demo:
            return
        if time.monotonic() < self.pause_until:
            self.status = 'FLOOD_WAIT: пауза 10 минут'
            return
        self.status = 'Загрузка…' if purpose != 'send' else 'Отправка…'
        self.pending = (self.pool.submit(backend, script, *args), purpose)
        self.last_refresh = time.monotonic()

    def refresh(self, older=False):
        if self.view == 'messages' and self.chat:
            args = [self.chat['id'], '40']
            if older and self.history.get('messages'):
                args += ['--before', str(self.history['messages'][0]['mid'])]
            self.submit('tgchat.py', args, 'older' if older else 'history')
        else:
            self.submit('tgcache.py', purpose='cache')

    def poll(self):
        if not self.pending or not self.pending[0].done():
            return
        future, purpose = self.pending
        self.pending = None
        try:
            result = future.result()
            if result.returncode:
                if result.returncode == 75:
                    self.pause_until = time.monotonic() + 600
                    self.status = 'FLOOD_WAIT: пауза 10 минут'
                elif result.returncode == 76 and time.monotonic() - self.last_start > 300:
                    self.last_start = time.monotonic()
                    self.submit('tgbrowser.py', ['restart'], 'start')
                elif result.returncode == 77:
                    self.status = 'Нужен вход. L — QR/пароль Telegram'
                else:
                    prefix = 'Исход неизвестен; НЕ повторяйте без проверки. ' if purpose == 'send' else 'Ошибка: '
                    self.status = prefix + clean(result.stderr or result.stdout)[-240:]
                return
            if purpose == 'cache':
                self.cache = self.load_cache()
            elif purpose in ('history', 'older'):
                history = json.loads(result.stdout)
                if purpose == 'older':
                    seen = {m['mid'] for m in self.history.get('messages', [])}
                    history['messages'] = [m for m in history['messages'] if m['mid'] not in seen] + self.history.get('messages', [])
                self.history = history
                if purpose == 'history':
                    self.index = max(0, len(self.items()) - 1)
            elif purpose == 'send':
                self.draft = ''
                self.reply = 0
                self.status = 'Отправлено'
                self.refresh()
                return
            elif purpose == 'start':
                self.refresh()
                return
            self.index = min(self.index, max(0, len(self.items()) - 1))
            self.status = 'Просмотр не помечает личные прочитанными'
        except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
            self.status = ('Исход неизвестен; проверьте чат. ' if purpose == 'send' else 'Ошибка: ') + clean(exc)[:180]

    def enter(self):
        items = self.items()
        if not items or self.pending:
            return
        selected = items[min(self.index, len(items) - 1)]
        if self.view == 'folders':
            self.folder = selected
            self.view = 'chats'
        elif self.view == 'chats':
            self.chat = selected
            self.draft = ''
            self.history = {}
            self.view = 'messages'
            self.refresh()
        else:
            self.reply = selected['mid']
            self.mode = 'compose'
            return
        self.index = self.offset = 0
        self.query = ''

    def back(self):
        if self.pending:
            return
        if self.view == 'chats' and self.tab == 'private':
            self.switch_tab('categories')
            return
        self.view = 'chats' if self.view == 'messages' else 'folders'
        self.index = self.offset = self.reply = 0
        self.query = ''
        self.draft = ''

    def put(self, row, value, attr=0):
        h, w = self.screen.getmaxyx()
        if 0 <= row < h:
            try:
                self.screen.addstr(row, 0, fit(value, max(0, w - 1)), attr)
            except curses.error:
                pass

    def aligned(self, left, right, width):
        right = fit(right, max(0, width // 3))
        rw = sum(cell_width(c) for c in right)
        left = fit(left, max(0, width - rw - 2))
        return left + ' ' * max(1, width - rw - sum(cell_width(c) for c in left)) + right

    def frame(self, row, label=''):
        width = max(0, self.screen.getmaxyx()[1] - 3)
        label = fit(' ' + label + ' ', max(0, width - 2)) if label else ''
        self.put(row, '╭' + label + '─' * max(0, width - sum(cell_width(c) for c in label)) + '╮', self.style())

    def draw(self):
        self.screen.erase()
        h, w = self.screen.getmaxyx()
        title = 'Папки' if self.view == 'folders' else self.folder if self.view == 'chats' else (self.chat or {}).get('title', '')
        accent, muted = self.style(), self.style('muted')
        themes = ['cyan', 'violet', 'green', 'amber', 'rose']
        self.put(0, self.aligned(' ◈ Telegram', '● ' + themes[self.theme] + ' · t', w - 2), accent | curses.A_BOLD)
        self.put(1, (' ▸ 1 Личные     2 Категории' if self.tab == 'private' else '   1 Личные   ▸ 2 Категории'), accent | curses.A_BOLD)
        title = 'Все чаты' if title == '@all' else title
        self.put(2, self.aligned(' ← ' + title if self.view != 'folders' else ' Категории', 'r ↻  / ⌕', w - 2), muted)
        self.put(3, '─' * max(0, w - 2), muted)
        items = self.items()
        capacity = max(1, h - 10)
        self.message_rows = []
        if self.view == 'messages':
            lines = []
            for i, m in enumerate(items):
                sender = 'Вы' if m.get('out') else m.get('from', '') or title
                prefix = self.aligned(sender, f"{m.get('date', '')} {m.get('time', '')}", max(2, w - 5))
                lines.append((i, prefix))
                lines.extend((i, '│ ' + line) for line in wrap(m.get('text') or '▣ медиа', max(2, w - 7)))
                lines.append((i, ''))
            positions = [j for j, (i, _) in enumerate(lines) if i == self.index]
            if positions and not self.manual_scroll:
                first, last = positions[0], positions[-1]
                if first < self.offset:
                    self.offset = first
                elif last >= self.offset + capacity:
                    self.offset = max(first, last - capacity + 1) if last - first < capacity else first
            self.offset = min(self.offset, max(0, len(lines) - capacity))
            for row, (i, line) in enumerate(lines[self.offset:self.offset + capacity], 4):
                self.put(row, ('▸ ' if i == self.index else '  ') + line,
                         accent if i == self.index or items[i].get('out') else 0)
                self.message_rows.append((row, i))
        else:
            count = max(1, capacity // 2)
            self.offset = min(self.offset, self.index)
            if self.index >= self.offset + count:
                self.offset = self.index - count + 1
            for slot, item in enumerate(items[self.offset:self.offset + count]):
                row, i = 4 + slot * 2, self.offset + slot
                selected = i == self.index
                data = self.cache['folders'].get(item, {}) if self.view == 'folders' else item
                name = ('Все чаты' if item == '@all' else item) if self.view == 'folders' else item.get('title', '')
                unread = data.get('unread', 0)
                badge = f'● {unread}' if unread else '✓'
                if self.view == 'chats':
                    badge = f"{data.get('time', '')}  {badge}"
                label = self.aligned(('▸ ' if selected else '  ') + name, badge, w - 3)
                self.put(row, label + ' ' * max(0, w - 2 - sum(cell_width(c) for c in label)),
                         self.style('selected') | curses.A_BOLD if selected else (accent if unread else 0))
                preview = data.get('last', '') if self.view == 'chats' else f"{len(data.get('chats', []))} чатов · Enter открыть"
                self.put(row + 1, '  ' + clean(preview).replace('\n', ' '), muted)
                self.message_rows.extend([(row, i), (row + 1, i)])
        if not items:
            self.put(4, 'Пока пусто' if not self.pending else 'Загрузка…')
        label = 'Подтверждение' if self.confirm else 'Поиск' if self.mode == 'search' else 'Ответ ↪' if self.reply else 'Сообщение' if self.view == 'messages' else 'Поиск чатов'
        self.frame(h - 6, label)
        if self.confirm:
            prompt = f"Отправить в «{self.confirm['title']}»? y/д · Esc отмена"
        elif self.mode:
            prompt = self.draft + '▏'
        elif self.query:
            prompt = self.query
        else:
            prompt = 'i — написать · Enter — ответить' if self.view == 'messages' else '/ — найти чат'
        content = fit(prompt, max(0, w - 5))
        self.put(h - 5, '│ ' + content + ' ' * max(0, w - 5 - sum(cell_width(c) for c in content)) + ' │', accent if self.mode or self.confirm else muted)
        self.put(h - 4, '╰' + '─' * max(0, w - 3) + '╯', accent)
        self.put(h - 3, ' ' + self.status, muted)
        self.put(h - 2, ' ↑↓ выбор · Enter открыть · Esc назад · q выход', muted)
        self.screen.refresh()

    def handle(self, key):
        if self.confirm:
            if key in ('y', 'Y', 'д', 'Д'):
                command = self.confirm
                self.confirm = None
                if not self.demo:
                    args = ['--peer', command['peer'], command['text']]
                    if command['reply']:
                        args += ['--reply', str(command['reply'])]
                    self.submit('tgmsg.py', args, 'send')
            elif key == '\x1b':
                self.confirm = None
                self.mode = 'compose'
            return True
        if self.mode:
            if key == '\x1b':
                self.mode = ''
                self.reply = 0
            elif key in ('\n', '\r', curses.KEY_ENTER):
                if self.mode == 'search':
                    self.query = self.draft
                    self.index = self.offset = 0
                elif self.draft.strip() and self.chat and not self.pending:
                    self.confirm = {'peer': self.chat['id'], 'title': self.chat['title'], 'text': self.draft, 'reply': self.reply}
                self.mode = ''
            elif key in (curses.KEY_BACKSPACE, '\x7f', '\b'):
                self.draft = self.draft[:-1]
            elif isinstance(key, str) and key.isprintable():
                self.draft += key
            return True
        if key in ('1', '2'):
            self.switch_tab('private' if key == '1' else 'categories')
        elif key == 't':
            self.cycle_theme()
        elif key in ('q', '\x03'):
            return False
        if key in (curses.KEY_UP, curses.KEY_DOWN):
            self.manual_scroll = False
            self.index = max(0, min(len(self.items()) - 1, self.index + (1 if key == curses.KEY_DOWN else -1)))
        elif key in ('\n', '\r', curses.KEY_ENTER):
            self.enter()
        elif key in ('\x1b', curses.KEY_LEFT, curses.KEY_BACKSPACE):
            self.back()
        elif key == '/' and self.view == 'chats':
            self.mode, self.draft = 'search', self.query
        elif key == 'i' and self.view == 'messages' and self.chat and self.history.get('kind') != 'channel':
            self.mode, self.reply = 'compose', 0
        elif key == 'r':
            self.refresh()
        elif key in (curses.KEY_PPAGE, curses.KEY_NPAGE) and self.view == 'messages':
            if key == curses.KEY_PPAGE and self.offset == 0:
                self.refresh(older=True)
            else:
                self.manual_scroll = True
                self.offset = max(0, self.offset + (1 if key == curses.KEY_NPAGE else -1) * max(1, self.screen.getmaxyx()[0] - 8))
        elif key == 'L' and not self.pending and not self.demo:
            curses.def_prog_mode()
            curses.endwin()
            try:
                subprocess.run([sys.executable, str(ROOT / 'backend/tgbrowser.py'), 'login'], check=False)
            finally:
                curses.reset_prog_mode()
                self.screen.refresh()
            self.refresh()
        elif key == curses.KEY_MOUSE:
            try:
                _, x, y, _, buttons = curses.getmouse()
                if buttons & curses.BUTTON1_CLICKED:
                    if y == 0:
                        self.cycle_theme()
                    elif y == 1:
                        self.switch_tab('private' if x < 14 else 'categories')
                    elif y == 2 and x < 5:
                        self.back()
                    elif y == self.screen.getmaxyx()[0] - 5:
                        if self.view == 'chats':
                            self.mode, self.draft = 'search', self.query
                        elif self.view == 'messages' and self.history.get('kind') != 'channel':
                            self.mode, self.reply = 'compose', 0
                    for row, index in self.message_rows:
                        if y == row:
                            self.index = index
                            if self.view != 'messages':
                                self.enter()
                            break
                elif buttons & (curses.BUTTON4_PRESSED | getattr(curses, 'BUTTON5_PRESSED', 0)):
                    delta = -1 if buttons & curses.BUTTON4_PRESSED else 1
                    if self.view == 'messages':
                        self.manual_scroll = True
                        self.offset = max(0, self.offset + delta * 3)
                    else:
                        self.index = max(0, min(max(0, len(self.items()) - 1), self.index + delta))
            except curses.error:
                pass
        return True

    def run(self):
        curses.curs_set(0)
        curses.use_default_colors()
        self.colors = curses.has_colors()
        self.palette()
        curses.mousemask(curses.ALL_MOUSE_EVENTS)
        self.screen.timeout(100)
        self.refresh()
        try:
            while True:
                self.poll()
                if not self.pending and not self.mode and not self.confirm and time.monotonic() - self.last_refresh >= 60:
                    self.refresh()
                self.draw()
                try:
                    key = self.screen.get_wch()
                except curses.error:
                    continue
                if not self.handle(key):
                    break
        finally:
            self.pool.shutdown(wait=False, cancel_futures=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, help='Offline JSON cache for UI checks; disables all backend calls and sends')
    args = parser.parse_args()
    try:
        fixture = json.loads(args.fixture.read_text()) if args.fixture else None
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    locale.setlocale(locale.LC_ALL, '')
    curses.wrapper(lambda screen: Pane(screen, fixture).run())


if __name__ == '__main__':
    main()
