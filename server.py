#!/usr/bin/env python3
import http.server, os, sys

port = int(os.environ.get('PORT', 3000))
handler = http.server.SimpleHTTPRequestHandler
handler.log_message = lambda *a: None  # suppress request noise
httpd = http.server.HTTPServer(('', port), handler)
print(f'Serving on port {port}', flush=True)
httpd.serve_forever()
