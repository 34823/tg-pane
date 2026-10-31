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
from typing import Any

import unicodedata

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('TG_PANE_DATA', '~/.local/share/tg-pane')).expanduser()


def clean(value):
    return ''.join(c for c in str(value) if c == '\n' or not unicodedata.category(c).startswith('C'))


def cell_width(c):
    return 0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in ('W', 'F') else 1


def width(value):
    return sum(cell_width(c) for c in value)


def fit(text, size):
    out, used = [], 0
    for c in clean(text).replace('\n', ' '):
        n = cell_width(c)
        if used + n > size:
            break
        out.append(c)
        used += n
    return ''.join(out)


def wrap(text, size):
    lines = []
    for paragraph in clean(text).split('\n'):
        line, used = '', 0
        for c in paragraph:
            n = cell_width(c)
            if used + n > max(2, size):
                cut = line.rfind(' ')
                if cut > 0:
                    lines.append(line[:cut])
                    line = line[cut + 1:]
                    used = width(line)
                else:
                    lines.append(line)
                    line, used = '', 0
                if used + n > max(2, size):
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
        self.view = 'chats'
        self.folder = '@all'
        self.chat = None
        self.history = {}
        self.index: int = 0
        self.offset = 0
        self.query = ''
        self.status = 'Демонстрация · без отправки' if self.demo else 'Обновление…'
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
        self.tab = 'all'
        self.list_offset = 0
        self.split = False
        self.list_rect = self.history_rect = None
        self.running = True
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
        curses.init_pair(4, 255 if curses.COLORS >= 256 else 7, 236 if curses.COLORS >= 256 else 0)
        curses.init_pair(5, 255 if curses.COLORS >= 256 else 7, 24 if curses.COLORS >= 256 else 4)

    def style(self, role='accent'):
        return curses.color_pair({'accent': 1, 'muted': 2, 'selected': 3, 'bubble': 4, 'own': 5}[role]) if self.colors else (curses.A_REVERSE if role == 'selected' else 0)

    def switch_tab(self, tab):
        if self.pending:
            return
        self.tab = tab
        self.view = 'folders' if tab == 'categories' else 'chats'
        self.folder = 'Личные' if tab == 'private' else '@all'
        self.index = self.offset = self.reply = self.list_offset = 0
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
            return self.panel_chats()
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
            self.draft = self.mode = ''
            self.reply = 0
            self.history = self.cache.get('histories', {}).get(str(selected['id']), {}) if self.demo else {}
            self.manual_scroll = False
            self.view = 'messages'
            self.refresh()
        else:
            if self.history.get('kind') == 'channel':
                return
            self.reply = selected['mid']
            self.mode = 'compose'
            return
        self.index = self.offset = 0
        if self.view != 'messages':
            self.query = ''
        if self.view == 'messages' and self.demo:
            self.index = max(0, len(self.items()) - 1)

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

    def paint(self, y, x, text, size, attr=0, fill=False):
        h, w = self.screen.getmaxyx()
        size = max(0, min(size, w - x - 1))
        if not (0 <= y < h and 0 <= x < w) or size == 0:
            return
        text = fit(text, size)
        if fill:
            text += ' ' * max(0, size - width(text))
        try:
            self.screen.addstr(y, x, text, attr)
        except curses.error:
            pass

    def target(self, x, y, w, h, action, value=None):
        self.targets.append((x, y, w, h, action, value))

    def button(self, y, x, label, action, value=None, active=False):
        self.paint(y, x, label, width(label), self.style('selected' if active else 'accent') | curses.A_BOLD)
        self.target(x, y, width(label), 1, action, value)

    def panel_chats(self):
        folders = self.cache.get('folders', {})
        chats = folders.get(self.folder, {}).get('chats', [])
        if self.tab == 'private' and 'Личные' not in folders:
            chats = [c for c in folders.get('@all', {}).get('chats', []) if c.get('kind') == 'user']
        return [c for c in chats if self.query.casefold() in c.get('title', '').casefold()]

    def draw_list(self, size, bottom):
        muted = self.style('muted')
        folders = self.view == 'folders'
        data = self.items() if folders else self.panel_chats()
        self.paint(3, 1, '⌕ ' + (self.draft + '▏' if self.mode == 'search' else self.query or 'Поиск'), size - 2,
                   self.style() if self.mode == 'search' else muted, True)
        self.target(0, 3, size, 1, 'search')
        title = 'Папки' if folders else 'Все чаты' if self.folder == '@all' else self.folder
        self.paint(4, 1, title, size - 2, muted)
        count = max(1, (bottom - 5) // 3)
        self.list_offset = min(self.list_offset, max(0, len(data) - count))
        if self.view != 'messages':
            self.list_offset = min(self.list_offset, self.index)
            if self.index >= self.list_offset + count:
                self.list_offset = max(0, self.index - count + 1)
        for slot, item in enumerate(data[self.list_offset:self.list_offset + count]):
            row, index = 5 + slot * 3, self.list_offset + slot
            if folders:
                info = self.cache['folders'].get(item, {})
                title = 'Все чаты' if item == '@all' else item
                preview = f"{len(info.get('chats', []))} чатов"
                selected = index == self.index
            else:
                info, title = item, item.get('title', '')
                preview = clean(item.get('last', '') or 'Нет сообщений').replace('\n', ' ')
                selected = str(item.get('id')) == str((self.chat or {}).get('id')) if self.view == 'messages' else index == self.index
            attr = self.style('selected') if selected else 0
            # A compact avatar occupies the first three cells, like Telegram's chat list.
            avatar = '▣' if folders else (fit(title.strip(), 1).upper() or '·')
            self.paint(row, 0, f' {avatar} ', 3, attr or self.style(), True)
            stamp = str(info.get('time', ''))
            available = max(0, size - 5 - width(stamp))
            caption = fit(title, available - 1) + '…' if width(title) > available else title
            self.paint(row, 3, caption, available, attr | curses.A_BOLD, True)
            self.paint(row, max(3, size - width(stamp) - 1), stamp, width(stamp), attr)
            unread = info.get('unread', 0)
            badge = f' {unread} ' if unread else ''
            self.paint(row + 1, 0, '   ' + preview, max(0, size - 1 - width(badge)), attr or muted, True)
            if badge:
                self.paint(row + 1, size - width(badge) - 1, badge, width(badge), self.style('selected'))
            self.paint(row + 2, 0, '─' * (size - 1), size - 1, muted)
            self.target(0, row, size, 3, 'folder' if folders else 'chat', index)
        if not data:
            self.paint(6, 2, 'Загрузка…' if self.pending else 'Нет чатов', size - 3, muted)
        self.list_rect = (0, 5, size, max(1, bottom - 5))

    def message_lines(self, size):
        lines = []
        previous_date = None
        for index, msg in enumerate(self.items()):
            date = msg.get('date', '')
            if date and date != previous_date:
                lines.append((index, 'date', date, False))
                previous_date = date
            own = bool(msg.get('out'))
            body = wrap(msg.get('text') or '▣ Медиа', max(2, size - 9))
            sender = 'Вы' if own else msg.get('from', '') or (self.chat or {}).get('title', '')
            if index == self.index:
                sender = '▸ ' + sender
            bubble_width = min(max(8, max([width(line) for line in body] + [width(sender) + 2, 10])), max(8, size - 8))
            lines.append((index, 'top', (bubble_width, sender), own))
            lines.extend((index, 'body', (bubble_width, line), own) for line in body)
            lines.append((index, 'bottom', (bubble_width, msg.get('time', '') + (' ✓' if own else '')), own))
            lines.append((index, 'space', '', own))
        return lines

    def draw_history(self, x, size, bottom):
        muted, accent = self.style('muted'), self.style()
        title = (self.chat or {}).get('title', '')
        self.paint(2, x, '', size, fill=True)
        self.button(2, x + 1, '‹', 'back')
        self.paint(2, x + 4, title, size - 15, curses.A_BOLD)
        self.button(2, x + size - 10, 'Обновить', 'refresh')
        self.paint(3, x + 4, 'канал' if self.history.get('kind') == 'channel' else 'без отметки «прочитано»', size - 5, muted)
        self.button(4, x + 1, '↑ Раньше', 'older')
        self.button(4, x + size - 10, '↓ К новым', 'latest')
        capacity = max(1, bottom - 5)
        lines = self.message_lines(size)
        positions = [j for j, (i, _, _, _) in enumerate(lines) if i == self.index]
        if positions and not self.manual_scroll:
            first, last = positions[0], positions[-1]
            if first < self.offset:
                self.offset = first
            elif last >= self.offset + capacity:
                self.offset = max(first, last - capacity + 1) if last - first < capacity else first
        self.offset = min(self.offset, max(0, len(lines) - capacity))
        for row, (i, kind, value, own) in enumerate(lines[self.offset:self.offset + capacity], 5):
            attr = self.style('own') if own else self.style('bubble')
            if kind == 'date':
                self.paint(row, x + max(1, (size - width(value)) // 2), value, size - 2, muted)
                continue
            if kind == 'space':
                continue
            bw, text = value
            start = x + max(1, size - bw - 4) if own else x + 1
            if kind == 'top':
                text = '╭ ' + fit(text, bw - 2)
                text += '─' * max(0, bw + 1 - width(text)) + '╮'
            elif kind == 'bottom':
                text = '╰' + '─' * max(0, bw - width(text) - 1) + ' ' + text + '╯'
            else:
                text = '│ ' + text + ' ' * max(0, bw - width(text) - 1) + '│'
            self.paint(row, start, text, size - (start - x) - 1, attr)
            self.target(start, row, min(bw + 2, size - (start - x) - 1), 1, 'message', i)
        self.history_rect = (x, 5, size, capacity)
        if not lines:
            self.paint(6, x + 2, 'Загрузка…' if self.pending else 'Пока нет сообщений', size - 3, muted)
        if self.items() and self.history.get('kind') != 'channel':
            self.button(bottom, x + 1, '↪ Ответить', 'reply')

    def draw_composer(self, x, size, h):
        muted, accent = self.style('muted'), self.style()
        if not self.chat or self.view != 'messages':
            return
        if self.history.get('kind') == 'channel':
            self.paint(h - 4, x + 2, 'Канал · только чтение', size - 3, muted)
            return
        if self.confirm:
            self.paint(h - 5, x + 1, 'Отправить сообщение?', size - 2, accent | curses.A_BOLD)
            self.button(h - 4, x + 1, ' Да, отправить ', 'confirm', active=True)
            self.button(h - 3, x + 1, ' Отмена ', 'cancel')
            return
        label = ' Ответ ↪ ' if self.reply else ' Сообщение '
        self.paint(h - 5, x + 1, '╭' + label + '─' * max(0, size - width(label) - 4) + '╮', size - 2, accent)
        prompt = self.draft + ('▏' if self.mode == 'compose' else '') if self.draft or self.mode == 'compose' else 'Написать…'
        content = fit(prompt, size - 7)
        self.paint(h - 4, x + 1, '│ ' + content + ' ' * max(0, size - 6 - width(content)) + '│', size - 2, accent if self.mode == 'compose' else muted, True)
        self.paint(h - 3, x + 1, '╰' + '─' * max(0, size - 4) + '╯', size - 2, accent)
        self.target(x + 1, h - 5, size - 2, 3, 'compose')
        # Small panes get a separate send row; never overlap input's hit area.
        if self.reply:
            self.button(h - 6, x + size - 10, '✕ Отмена', 'clear_reply')
        self.button(h - 2, x + size - 14, ' Отправить ➤ ', 'send', active=bool(self.draft.strip()))

    def draw(self):
        self.screen.erase()
        self.targets = []
        self.list_rect = self.history_rect = None
        h, w = self.screen.getmaxyx()
        if h < 12 or w < 24:
            self.paint(0, 0, 'Telegram · увеличьте панель', w - 1, self.style())
            self.screen.refresh()
            return
        self.split = w >= 64
        sidebar = min(34, max(25, w // 3)) if self.split else w - 1
        self.button(0, 1, 'Telegram', 'all', active=False)
        self.button(0, w - 11 if w < 40 else w - 17, '●' if w < 40 else '● Тема', 'theme')
        self.button(0, w - 8, '↻', 'refresh')
        self.button(0, w - 4, '×', 'quit')
        self.button(1, 0, ' Все ', 'all', active=self.tab == 'all')
        self.button(1, 6, ' Личные ', 'tab', 'private', self.tab == 'private')
        self.button(1, 15, ' Папки ', 'tab', 'categories', self.tab == 'categories')
        self.paint(2, 0, '─' * (w - 1), w - 1, self.style('muted'))
        bottom = h - 7
        if self.split or self.view != 'messages':
            self.draw_list(sidebar, h - 2)
        if self.split:
            for row in range(2, h - 1):
                self.paint(row, sidebar, '│', 1, self.style('muted'))
        x, size = (sidebar + 1, w - sidebar - 2) if self.split else (0, w - 1)
        if self.view == 'messages':
            self.draw_history(x, size, bottom)
            self.draw_composer(x, size, h)
        elif self.split:
            self.paint(max(6, h // 2 - 1), x + 2, '✉', size - 3, self.style())
            self.paint(max(7, h // 2), x + 2, 'Выберите чат слева', size - 3, self.style('muted'))
        self.paint(h - 1, 1, self.status, w - 2, self.style('muted'))
        if self.mode == 'search':
            self.button(4, max(1, sidebar - 5), '✕', 'clear_search')
        if 'вход' in self.status.lower():
            self.button(h - 2, 1, 'Войти в Telegram', 'login')
        self.screen.refresh()

    @staticmethod
    def inside(rect, x, y):
        return rect and rect[0] <= x < rect[0] + rect[2] and rect[1] <= y < rect[1] + rect[3]

    def mouse(self, x, y, buttons):
        wheel = curses.BUTTON4_PRESSED | getattr(curses, 'BUTTON5_PRESSED', 0)
        if buttons & wheel:
            if self.confirm:
                return
            delta = -1 if buttons & curses.BUTTON4_PRESSED else 1
            if self.inside(self.history_rect, x, y):
                self.manual_scroll = True
                self.offset = max(0, self.offset + delta * 3)
            elif self.inside(self.list_rect, x, y):
                self.list_offset = max(0, self.list_offset + delta)
                if self.view != 'messages':
                    self.index = self.list_offset
            return
        # React on release, not press: works with SGR mouse and avoids double activation.
        click = curses.BUTTON1_RELEASED | curses.BUTTON1_CLICKED | curses.BUTTON1_DOUBLE_CLICKED
        if not buttons & click:
            return
        for tx, ty, tw, th, action, value in reversed(self.targets):
            if self.inside((tx, ty, tw, th), x, y):
                if self.confirm and action not in ('confirm', 'cancel'):
                    return
                self.action(action, value, bool(buttons & curses.BUTTON1_DOUBLE_CLICKED))
                return

    def action(self, action, value=None, double=False):
        if action == 'theme':
            self.cycle_theme()
        elif action == 'confirm':
            self.handle('y')
        elif action == 'cancel':
            self.handle('\x1b')
        elif action in ('tab', 'all'):
            self.switch_tab(value if action == 'tab' else 'all')
        elif action == 'back':
            self.mode = ''
            self.back()
        elif action == 'refresh':
            self.refresh()
        elif action == 'older':
            self.refresh(older=True)
        elif action == 'latest':
            self.manual_scroll = False
            self.index = max(0, len(self.items()) - 1)
        elif action == 'search' and not self.pending:
            if self.view == 'folders':
                self.switch_tab('all')
            self.mode, self.draft = 'search', self.query
        elif action == 'clear_search':
            self.mode = self.query = self.draft = ''
        elif action in ('chat', 'folder') and not self.pending:
            if not isinstance(value, int):
                return
            self.mode = ''
            if action == 'chat':
                data = self.panel_chats()
                if value >= len(data):
                    return
                self.view = 'chats'
            self.index = value
            self.enter()
        elif action == 'message':
            if not isinstance(value, int):
                return
            self.index = value
            self.manual_scroll = True
            if double:
                self.action('reply')
        elif action == 'reply' and self.view == 'messages' and self.history.get('kind') != 'channel':
            self.mode = ''
            self.enter()
        elif action == 'compose' and self.view == 'messages' and self.history.get('kind') != 'channel':
            self.mode = 'compose'
        elif action == 'clear_reply':
            self.reply = 0
        elif action == 'send' and self.view == 'messages' and self.history.get('kind') != 'channel':
            self.mode = 'compose'
            self.handle('\n')
        elif action == 'login':
            self.mode = ''
            self.handle('L')
        elif action == 'quit':
            self.running = False

    def handle(self, key):
        if key == curses.KEY_MOUSE:
            try:
                _, x, y, _, buttons = curses.getmouse()
                self.mouse(x, y, buttons)
            except curses.error:
                pass
            return True
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
            if self.mode == 'search':
                self.query = self.draft
                self.index = self.list_offset = 0
            return True
        if key == '0':
            self.switch_tab('all')
        elif key in ('1', '2'):
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
            while self.running:
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
