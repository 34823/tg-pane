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
            chats = self.cache.get('folders', {}).get(self.folder, {}).get('chats', [])
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

    def draw(self):
        self.screen.erase()
        h, w = self.screen.getmaxyx()
        title = 'Папки' if self.view == 'folders' else self.folder if self.view == 'chats' else (self.chat or {}).get('title', '')
        self.put(0, 'TG Pane  ·  ' + ('Все чаты' if title == '@all' else title), curses.A_BOLD)
        self.put(1, '↑↓ выбор · Enter открыть/ответ · Esc назад · q выход')
        self.put(2, 'r обновить · / поиск · i писать · PgUp раньше · L вход')
        items = self.items()
        capacity = max(1, h - 7)
        self.message_rows = []
        if self.view == 'messages':
            lines = []
            for i, m in enumerate(items):
                prefix = f"{m.get('date', '')} {m.get('time', '')}  " + ('Вы' if m.get('out') else m.get('from', ''))
                lines.append((i, prefix))
                lines.extend((i, '  ' + line) for line in wrap(m.get('text') or '[медиа]', max(2, w - 4)))
                lines.append((i, ''))
            positions = [j for j, (i, _) in enumerate(lines) if i == self.index]
            if positions and not self.manual_scroll:
                first, last = positions[0], positions[-1]
                if first < self.offset:
                    self.offset = first
                elif last >= self.offset + capacity:
                    self.offset = max(first, last - capacity + 1) if last - first < capacity else first
            self.offset = min(self.offset, max(0, len(lines) - capacity))
            for row, (i, line) in enumerate(lines[self.offset:self.offset + capacity], 3):
                self.put(row, ('▸ ' if i == self.index else '  ') + line,
                         curses.A_REVERSE if i == self.index else 0)
                self.message_rows.append((row, i))
        else:
            self.offset = min(self.offset, self.index)
            if self.index >= self.offset + capacity:
                self.offset = self.index - capacity + 1
            for row, item in enumerate(items[self.offset:self.offset + capacity], 3):
                i = self.offset + row - 3
                if self.view == 'folders':
                    folder = self.cache['folders'].get(item, {})
                    label = f"{'Все чаты' if item == '@all' else item}  ({folder.get('unread', 0)})"
                else:
                    label = f"{item.get('title', '')}  ({item.get('unread', 0)}) {item.get('time', '')} · {item.get('last', '')}"
                self.put(row, ('▸ ' if i == self.index else '  ') + label, curses.A_REVERSE if i == self.index else 0)
                self.message_rows.append((row, i))
        if not items:
            self.put(4, 'Пока пусто' if not self.pending else 'Загрузка…')
        if self.confirm:
            self.put(h - 3, f"Отправить в «{self.confirm['title']}»? y — да, Esc — отмена", curses.A_BOLD)
        elif self.mode:
            self.put(h - 3, ('Поиск: ' if self.mode == 'search' else f'Сообщение{" ↪" if self.reply else ""}: ') + self.draft, curses.A_BOLD)
        elif self.query:
            self.put(h - 3, 'Фильтр: ' + self.query)
        else:
            self.put(h - 3, 'i — новое сообщение · Enter — ответ' if self.view == 'messages' else 'Выберите папку/чат')
        self.put(h - 2, self.status)
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
        if key in ('q', '\x03'):
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
                _, _, y, _, buttons = curses.getmouse()
                if buttons & curses.BUTTON1_CLICKED:
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
