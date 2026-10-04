#!/usr/bin/env python3
"""Local server for Petal Patrol.

Same as `python3 -m http.server`, but tells the browser not to cache files,
so edits to the code, balance.json or maps.json show up on a normal reload.

Usage: python3 serve.py [port]   (default port 8765)
"""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
print(f'Petal Patrol running at http://localhost:{port}  (Ctrl+C to stop)')
http.server.ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
