import importlib.util
from concurrent.futures import Future
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

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
    def getmaxyx(self): return self.height, self.width
    def erase(self): self.lines = {}
    def refresh(self): pass
    def addstr(self, row, col, value, attr=0):
        assert sum(tg.cell_width(c) for c in value) < self.width
        self.lines[row] = value


class TerminalTests(unittest.TestCase):
    def pane(self, width=72, height=24):
        pane = tg.Pane(Screen(width, height), CACHE)
        self.addCleanup(pane.pool.shutdown)
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

    def test_send_requires_explicit_confirmation_and_exact_target(self):
        p = self.pane()
        p.enter(); p.enter()
        p.handle('i')
        for ch in 'Привет; $(danger)': p.handle(ch)
        with patch.object(p, 'submit') as submit:
            p.handle('\n')
            submit.assert_not_called()
            self.assertEqual(p.confirm['peer'], '42')
            p.handle('\x1b')
            submit.assert_not_called()
            p.handle('\n')
            p.demo = False
            p.handle('y')
            submit.assert_called_once_with('tgmsg.py', ['--peer', '42', 'Привет; $(danger)'], 'send')

    def test_reply_and_draft_cleared_after_verified_send(self):
        p = self.pane()
        p.enter(); p.enter()
        p.history = {'messages': [{'mid': 12, 'text': 'Reply to me'}]}
        p.enter()
        self.assertEqual(p.reply, 12)
        p.draft = 'answer'
        p.handle('\n')
        p.demo = False
        with patch.object(p, 'submit') as submit:
            p.handle('y')
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
        self.assertIn('1 Личные', p.screen.lines[1])
        p.handle('2')
        self.assertEqual(p.view, 'folders')
        for _ in range(6):
            p.handle('t')
        self.assertEqual(p.theme, 1)
        p.enter()
        p.draw()
        self.assertIn('Test', p.screen.lines[4])
        self.assertIn('● 3', p.screen.lines[4])
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

    def test_fixture_never_calls_backend(self):
        p = self.pane()
        with patch.object(tg, 'backend', side_effect=AssertionError('must not run')):
            p.refresh(); p.enter(); p.enter(); p.refresh()
        self.assertIsNone(p.pending)


if __name__ == '__main__': unittest.main()
