import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parents[1] / 'backend'
sys.path.insert(0, str(BACKEND))
spec = importlib.util.spec_from_file_location('tgbrowser', BACKEND / 'tgbrowser.py')
assert spec is not None and spec.loader is not None
browser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(browser)


class BrowserProcessTests(unittest.TestCase):
    def test_normal_and_flattened_argv(self):
        port = f'--remote-debugging-port={browser.PORT}'.encode()
        self.assertTrue(browser.is_main_browser([b'/opt/chrome', port]))
        self.assertTrue(browser.is_main_browser([b'/opt/chrome ' + port + b' --no-sandbox']))
        self.assertFalse(browser.is_main_browser([b'/opt/chrome ' + port + b' --type=renderer']))
        self.assertFalse(browser.is_main_browser([b'/opt/chrome', port + b'0']))
        self.assertFalse(browser.is_main_browser([b'python', port]))

    def test_restart_waits_for_port_to_close(self):
        with patch.object(browser, 'stop') as stop, patch.object(browser, 'alive', side_effect=[True, False]), \
             patch.object(browser, 'start') as start, patch.object(browser.time, 'sleep'):
            browser.restart()
            stop.assert_called_once(); start.assert_called_once()

    def test_restart_will_not_launch_duplicate_if_stop_fails(self):
        with patch.object(browser, 'stop'), patch.object(browser, 'alive', return_value=True), \
             patch.object(browser, 'start') as start, patch.object(browser.time, 'sleep'):
            with self.assertRaises(SystemExit): browser.restart()
            start.assert_not_called()


if __name__ == '__main__': unittest.main()
