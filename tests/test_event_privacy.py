import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('hermes_hook', ROOT / 'hermes_plugin.py')
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class EventPrivacyTests(unittest.TestCase):
    def test_hermes_metadata_uses_stdin_not_arguments(self):
        page = '/private/client name/研究 project'
        session = 'private-session-id'
        with patch.object(hook.SCRIPT.__class__, 'is_file', return_value=True), \
                patch.object(hook.os, 'getcwd', return_value=page), \
                patch.object(hook.subprocess, 'run') as run:
            hook._emit(session, 'working')
        args, options = run.call_args
        self.assertEqual(args[0], [sys.executable, str(hook.SCRIPT), 'event-stdin'])
        self.assertNotIn(page, ' '.join(args[0]))
        self.assertNotIn(session, ' '.join(args[0]))
        self.assertEqual(json.loads(options['input']), {
            'agent': 'hermes', 'session': session, 'state': 'working', 'page': page})
        self.assertEqual(options['timeout'], 2)
        self.assertEqual(options['stdout'], subprocess.DEVNULL)
        self.assertEqual(options['stderr'], subprocess.DEVNULL)

    def invoke(self, state_home, command, payload=None):
        return subprocess.run([sys.executable, str(ROOT / 'status.py'), *command],
                              input=payload, capture_output=True,
                              env={**os.environ, 'XDG_STATE_HOME': str(state_home)}, timeout=5)

    def test_stdin_event_stores_only_label_and_hashed_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            page = '/private/client name/研究 project'
            session = 'private-session-id'
            result = self.invoke(tmp, ['event-stdin'], json.dumps({
                'agent': 'hermes', 'session': session, 'state': 'attention', 'page': page}).encode())
            self.assertEqual(result.returncode, 0, result.stderr)
            record = json.loads(next(Path(tmp).glob('omarchy/agent-status/events/hermes/*.json')).read_text())
            self.assertEqual(record['page'], '研究 project')
            self.assertEqual(record['state'], 'attention')
            self.assertEqual(record['session'], hashlib.sha256(session.encode()).hexdigest()[:20])
            self.assertNotIn(page, json.dumps(record))
            self.assertNotIn(session, json.dumps(record))

    @unittest.skipUnless(Path('/proc/self/cmdline').is_file(), 'requires Linux procfs')
    def test_real_hook_child_cmdline_has_no_private_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            bridge = Path(tmp) / 'bridge.py'
            bridge.write_text(
                'from pathlib import Path\nimport runpy\n'
                'Path(__file__).with_suffix(".cmdline").write_bytes(Path("/proc/self/cmdline").read_bytes())\n'
                f'runpy.run_path({str(ROOT / "status.py")!r}, run_name="__main__")\n')
            page = '/private/client name/secret-project'
            session = 'private-session-id'
            with patch.object(hook, 'SCRIPT', bridge), \
                    patch.object(hook.os, 'getcwd', return_value=page), \
                    patch.dict(os.environ, {'XDG_STATE_HOME': tmp}):
                hook._emit(session, 'done')
            cmdline = bridge.with_suffix('.cmdline').read_bytes()
            self.assertNotIn(page.encode(), cmdline)
            self.assertNotIn(session.encode(), cmdline)
            self.assertEqual(cmdline.split(b'\0')[-2], b'event-stdin')
            record = json.loads(next(Path(tmp).glob('omarchy/agent-status/events/hermes/*.json')).read_text())
            self.assertEqual(record['page'], 'secret-project')
            self.assertEqual(record['state'], 'done')

    def test_invalid_input_is_rejected_without_echoing_metadata(self):
        for payload in (b'private malformed input', b'[]', b'{"agent":"hermes"}',
                        b'{"agent":"hermes","session":{},"state":"done"}',
                        b'{"agent":"hermes","session":"s","state":"done","page":[]}'):
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as tmp:
                result = self.invoke(tmp, ['event-stdin'], payload)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stderr.strip(), b'invalid event input')
                self.assertFalse(list(Path(tmp).rglob('*.json')))

    def test_existing_event_command_remains_compatible(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self.invoke(tmp, ['event', 'herder', 'session', 'working', 'project-label'])
            self.assertEqual(result.returncode, 0, result.stderr)
            record = json.loads(next(Path(tmp).glob('omarchy/agent-status/events/herder/*.json')).read_text())
            self.assertEqual(record['page'], 'project-label')

    def test_hook_failure_does_not_interrupt_hermes(self):
        with patch.object(hook.SCRIPT.__class__, 'is_file', return_value=True), \
                patch.object(hook.subprocess, 'run', side_effect=subprocess.TimeoutExpired('bridge', 2)):
            hook._emit('session', 'working')


if __name__ == '__main__':
    unittest.main()
