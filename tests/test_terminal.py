import importlib.util
from concurrent.futures import Future
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
spec = importlib.util.spec_from_file_location('terminal', Path(__file__).resolve().parents[1] / 'terminal.py')
assert spec is not None and spec.loader is not None
tg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tg)

CACHE = {'folders': {'@all': {'chats': [{'id': '42', 'title': 'Test', 'kind': 'user', 'unread': 3}]},
                     'Личные': {'chats': []}}, 'order': ['@all', 'Личные']}


class Screen:
    def __init__(self, width=72, height=24):
        self.width, self.height = width, height
        self.lines = {}
        self.writes = []
    def getmaxyx(self): return self.height, self.width
    def erase(self):
        self.lines = {}
        self.writes = []
    def refresh(self): pass
    def addstr(self, row, col, value, attr=0):
        assert col + sum(tg.cell_width(c) for c in value) < self.width
        self.writes.append((row, col, value, attr))
        old = self.lines.get(row, '')
        self.lines[row] = old[:col].ljust(col) + value + old[col + len(value):]


class TerminalTests(unittest.TestCase):
    def pane(self, width=72, height=24):
        pane = tg.Pane(Screen(width, height), CACHE)
        self.addCleanup(pane.pool.shutdown)
        pane.switch_tab('categories')
        return pane

    def test_folders_unique_and_navigation_is_read_only(self):
        p = self.pane()
        self.assertEqual(p.items(), ['@all', 'Личные'])
        p.enter()
        self.assertEqual(p.view, 'chats')
        p.draft = 'Text for a different chat'
        p.enter()
        self.assertEqual(p.chat['id'], '42')
        self.assertEqual(p.draft, '')
        p.demo = False
        with patch.object(p, 'submit') as submit:
            p.refresh()
            self.assertEqual(submit.call_args.args, ('tgchat.py', ['42', '40'], 'history'))
            self.assertNotIn('--read', str(submit.call_args))

    def test_enter_sends_immediately_to_exact_target(self):
        p = self.pane()
        p.enter(); p.enter()
        p.handle('i')
        for ch in 'Привет; $(danger)': p.handle(ch)
        p.demo = False
        with patch.object(p, 'submit') as submit:
            p.handle('\n')
            submit.assert_called_once_with('tgmsg.py', ['--peer', '42', 'Привет; $(danger)'], 'send')

    def test_reply_and_draft_cleared_after_verified_send(self):
        p = self.pane()
        p.enter(); p.enter()
        p.history = {'messages': [{'mid': 12, 'text': 'Reply to me'}]}
        p.enter()
        self.assertEqual(p.reply, 12)
        p.draft = 'answer'
        p.demo = False
        with patch.object(p, 'submit') as submit:
            p.handle('\n')
            submit.assert_called_once_with('tgmsg.py', ['--peer', '42', 'answer', '--reply', '12'], 'send')
        f = Future(); f.set_result(subprocess.CompletedProcess([], 0, 'sent', ''))
        p.pending = (f, 'send')
        with patch.object(p, 'refresh'): p.poll()
        self.assertEqual(p.draft, '')
        self.assertEqual(p.reply, 0)

    def test_flood_and_unknown_send_never_auto_retry(self):
        p = self.pane(); p.demo = False
        for code in [75, 1]:
            f = Future(); f.set_result(subprocess.CompletedProcess([], code, '', 'error'))
            p.pending = (f, 'send')
            with patch.object(p, 'submit') as submit:
                p.poll(); submit.assert_not_called()
        self.assertGreater(p.pause_until, 0)
        self.assertIn('НЕ повторяйте', p.status)

    def test_terminal_injection_and_widths(self):
        self.assertNotIn('\x1b', tg.clean('unsafe\x1b[2J'))
        for width in [8, 24, 32, 72, 120]:
            for height in [5, 12, 30]:
                p = self.pane(width, height)
                p.draw(); p.enter(); p.draw(); p.enter()
                p.history = {'messages': [{'mid': 1, 'text': 'Русский 中🙂 ' * 90}]}
                p.draw()
                self.assertTrue(tg.wrap('中' * 8, width))

    def test_tabs_theme_and_chat_preview(self):
        p = self.pane()
        p.handle('1')
        self.assertEqual((p.tab, p.view, p.folder), ('private', 'chats', 'Личные'))
        p.draw()
        self.assertIn('Личные', p.screen.lines[1])
        p.handle('2')
        self.assertEqual(p.view, 'folders')
        for _ in range(6):
            p.handle('t')
        self.assertEqual(p.theme, 1)
        p.enter()
        p.draw()
        self.assertIn('Test', p.screen.lines[5])
        self.assertIn('3', p.screen.lines[6])
        p.enter(); p.draw()
        self.assertTrue(any('╭' in s for s in p.screen.lines.values()))

    def test_private_fallback_and_switch_during_load(self):
        p = self.pane()
        p.cache = {'folders': {'@all': {'chats': [
            {'id': '1', 'title': 'Person', 'kind': 'user'},
            {'id': '2', 'title': 'Channel', 'kind': 'channel'}]}}}
        p.handle('1')
        self.assertEqual([c['id'] for c in p.items()], ['1'])
        p.pending = (Future(), 'cache')
        p.handle('2')
        self.assertEqual(p.tab, 'private')

    def click(self, p, action, value=None):
        p.draw()
        target = next(t for t in p.targets if t[4] == action and (value is None or t[5] == value))
        p.mouse(target[0], target[1], tg.curses.BUTTON1_RELEASED)

    def test_mouse_send_is_immediate(self):
        p = self.pane()
        self.click(p, 'all')
        self.click(p, 'chat', 0)
        self.click(p, 'compose')
        for char in 'Mouse draft': p.handle(char)
        p.demo = False
        with patch.object(p, 'submit') as submit:
            self.click(p, 'send')
            submit.assert_called_once_with('tgmsg.py', ['--peer', '42', 'Mouse draft'], 'send')
        self.assertFalse(any(t[4] in ('confirm', 'cancel') for t in p.targets))

    def test_mouse_search_is_live_and_works_while_editing(self):
        p = self.pane()
        self.click(p, 'all')
        self.click(p, 'search')
        p.handle('T'); p.handle('e')
        self.assertEqual(len(p.panel_chats()), 1)
        p.handle('x')
        self.assertEqual(p.panel_chats(), [])
        self.click(p, 'clear_search')
        self.assertEqual(p.query, '')
        self.click(p, 'tab', 'private')
        self.assertEqual(p.tab, 'private')

    def test_mouse_reply_and_back_while_composing(self):
        p = self.pane()
        p.switch_tab('all'); p.enter()
        p.history = {'messages': [{'mid': 7, 'text': 'hello'}]}
        self.click(p, 'message', 0)
        self.click(p, 'reply')
        self.assertEqual(p.reply, 7)
        self.click(p, 'clear_reply')
        self.assertEqual(p.reply, 0)
        self.click(p, 'back')
        self.assertEqual((p.view, p.mode), ('chats', ''))

    def test_pending_send_does_not_duplicate_and_keeps_draft(self):
        p = self.pane()
        p.switch_tab('all'); p.enter()
        p.demo = False
        p.mode, p.draft = 'compose', 'hi'
        p.pending = (Future(), 'send')
        with patch.object(p, 'submit') as submit:
            p.handle('\n')
            self.click(p, 'send')
            submit.assert_not_called()
        self.assertEqual(p.draft, 'hi')

    def test_chat_rows_have_no_avatar_and_full_selection_background(self):
        p = self.pane()
        p.switch_tab('all')
        p.cache = {'folders': {'@all': {'chats': [
            {'id': '42', 'title': 'Shah', 'time': '1.10', 'unread': 3, 'last': 'preview'}]}}}
        p.draw()
        self.assertTrue(p.screen.lines[5].startswith(' Shah'))
        bases = [v for row, col, v, attr in p.screen.writes if row in (5, 6) and col == 0]
        self.assertEqual(len(bases), 2)
        self.assertEqual([tg.width(v) for v in bases], [24, 24])

    def test_message_and_input_borders_align_without_truncation(self):
        for columns in (24, 32, 70, 120):
            p = self.pane(columns, 40)
            p.switch_tab('all'); p.enter()
            p.history = {'messages': [{'mid': 1, 'from': 'Sender', 'time': '14:50',
                                       'text': 'Привет! Русский текст и 中🙂 ' * 2}]}
            p.draw()
            targets = [t for t in p.targets if t[4] == 'message']
            self.assertGreaterEqual(len(targets), 3)
            self.assertEqual(len({(x, n) for x, _, n, _, _, _ in targets}), 1)
            for x, row, n, _, _, _ in targets:
                painted = [v for y, col, v, _ in p.screen.writes if y == row and col == x]
                self.assertEqual(tg.width(painted[-1]), n)
                self.assertIn(painted[-1][-1], '╮│╯')
            self.assertNotIn('Отправить сообщение?', '\n'.join(p.screen.lines.values()))

    def test_wheel_scrolls_hovered_column_only(self):
        p = self.pane()
        p.switch_tab('all'); p.enter()
        p.history = {'messages': [{'mid': i, 'text': 'A long message ' * 10} for i in range(30)]}
        p.index = 29
        p.draw()
        offset = p.offset
        x, y, _, _ = p.history_rect
        p.mouse(x, y, tg.curses.BUTTON4_PRESSED)
        self.assertEqual(p.offset, offset - 3)
        x, y, _, _ = p.list_rect
        p.mouse(x, y, getattr(tg.curses, 'BUTTON5_PRESSED', 0))
        self.assertEqual(p.offset, offset - 3)
        self.assertEqual(p.list_offset, 1)

    def test_channel_has_no_send_or_reply_controls(self):
        p = self.pane()
        p.switch_tab('all'); p.enter()
        p.history = {'kind': 'channel', 'messages': [{'mid': 1, 'text': 'News'}]}
        p.draw()
        self.assertFalse(any(t[4] in ('compose', 'send', 'reply') for t in p.targets))
        p.enter()
        self.assertEqual(p.reply, 0)

    def test_narrow_view_and_resize_preserve_history(self):
        p = self.pane(32, 30)
        p.switch_tab('all'); p.enter()
        p.history = {'messages': [{'mid': 1, 'text': 'слова без рваных переносов ' * 10}]}
        p.draw()
        self.assertFalse(p.split)
        self.assertIsNone(p.list_rect)
        p.screen.width = 100
        p.draw()
        self.assertTrue(p.split)
        self.assertIsNotNone(p.list_rect)
        self.assertEqual(p.history['messages'][0]['mid'], 1)
        for line in tg.wrap('Русский 中🙂 очень длинный текст', 12):
            self.assertLessEqual(sum(tg.cell_width(c) for c in line), 12)

    def test_fixture_never_calls_backend(self):
        p = self.pane()
        with patch.object(tg, 'backend', side_effect=AssertionError('must not run')):
            p.refresh(); p.enter(); p.enter(); p.refresh()
        self.assertIsNone(p.pending)


if __name__ == '__main__': unittest.main()
