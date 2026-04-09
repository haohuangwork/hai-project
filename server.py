#!/usr/bin/env python3
import http.server, os, json, urllib.request, urllib.error

# Load .env if present
_env_path = os.path.join(os.path.dirname(__file__), '.env')
if os.path.exists(_env_path):
    with open(_env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())

PORT     = int(os.environ.get('PORT', 3000))
API_KEY  = os.environ.get('ANTHROPIC_API_KEY', '')
BASE_URL = os.environ.get('ANTHROPIC_BASE_URL', 'https://api.anthropic.com')

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path == '/api/chat':
            self._proxy_chat()
        else:
            self.send_error(404)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _proxy_chat(self):
        length = int(self.headers.get('Content-Length', 0))
        body   = self.rfile.read(length)
        try:
            payload = json.loads(body)
        except Exception:
            self.send_error(400, 'Bad JSON')
            return

        upstream_body = json.dumps({
            'model': 'claude-sonnet-4-20250514',
            'max_tokens': 1000,
            'stream': True,
            'system': payload.get('system', ''),
            'messages': payload.get('messages', []),
        }).encode()

        req = urllib.request.Request(
            f'{BASE_URL}/v1/messages',
            data=upstream_body,
            headers={
                'Content-Type': 'application/json',
                'x-api-key': API_KEY,
                'anthropic-version': '2023-06-01',
            },
            method='POST',
        )

        try:
            with urllib.request.urlopen(req) as resp:
                self.send_response(200)
                self._cors()
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('X-Accel-Buffering', 'no')
                self.end_headers()
                while True:
                    chunk = resp.read(4096)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except urllib.error.HTTPError as e:
            err = e.read()
            self.send_response(e.code)
            self._cors()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(err)
        except Exception as e:
            self.send_error(502, str(e))

httpd = http.server.HTTPServer(('', PORT), Handler)
print(f'Serving on port {PORT}', flush=True)
httpd.serve_forever()
