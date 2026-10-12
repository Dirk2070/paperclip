"""Check that verification helpers cannot take ownership of another checkout."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.request


class OwnershipSafety(unittest.TestCase):
    def test_foreign_checkout_server_remains_alive(self):
        repo = Path(__file__).resolve().parents[4]
        helpers = repo / '.agents/skills/verify-paperclip/scripts'
        with tempfile.TemporaryDirectory(prefix='paperclip-ownership-test-') as temp:
            root = Path(temp)
            foreign = root / 'another-checkout'
            foreign.mkdir()
            server = subprocess.Popen(
                [sys.executable, '-u', '-c',
                 "from http.server import HTTPServer, BaseHTTPRequestHandler\n"
                 "class Handler(BaseHTTPRequestHandler):\n"
                 " def do_GET(self):\n"
                 "  self.send_response(200); self.end_headers(); self.wfile.write(b'foreign fixture alive')\n"
                 " def log_message(self, *args): pass\n"
                 "server = HTTPServer(('127.0.0.1', 0), Handler)\n"
                 "print(server.server_port, flush=True)\n"
                 "server.serve_forever()\n"],
                cwd=foreign, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True,
            )
            try:
                port = int(server.stdout.readline().strip())
                url = f'http://127.0.0.1:{port}'
                data = root / 'verification-data'
                instance = data / 'instances/default'
                instance.mkdir(parents=True)
                evidence = root / 'evidence'
                evidence.mkdir()
                # The claimed PID really owns this port, but its cwd is foreign.
                (evidence / 'launch.json').write_text(json.dumps({
                    'repo': str(repo), 'dataDir': str(data), 'port': port,
                    'url': url, 'launcherPid': server.pid,
                }))
                (instance / 'runtime-info.json').write_text(json.dumps({
                    'pid': server.pid, 'port': port, 'dashboardUrl': url,
                    'host': '127.0.0.1',
                }))
                for helper in ['doctor.py', 'stop.py']:
                    with self.subTest(helper=helper):
                        result = subprocess.run(
                            [sys.executable, str(helpers / helper),
                             '--evidence-dir', str(evidence)],
                            capture_output=True, text=True, timeout=10,
                        )
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn('checkout', result.stdout + result.stderr)
                        self.assertIsNone(server.poll(), 'Helper killed foreign server')
                        with urllib.request.urlopen(url, timeout=5) as response:
                            self.assertEqual(response.read(), b'foreign fixture alive')
                self.assertFalse((evidence / 'cleanup.json').exists())
            finally:
                server.terminate()
                try:
                    server.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.communicate()


if __name__ == '__main__':
    unittest.main()
