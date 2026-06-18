"""Dev server for the model-review editor.

Serves the project root (so the editor + species JSONs load) AND accepts
POST /save-pov to write a creature's POV anchor back into its species JSON:

    POST /save-pov   { "id": "jaguar", "forward": 1.5, "height": 0.4 }

The pov field is patched into the file with a targeted line edit, so the rest
of the JSON (comments, compact model.parts arrays) is left byte-for-byte intact.

Run:  python model-review/server.py    (serves on http://localhost:8123)
"""
import http.server, socketserver, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # project root
PORT = 8123
ID_RE = re.compile(r"^[a-z0-9_]+$")


def fmt(n):
    # tidy number: up to 3 decimals, no trailing zeros (1.5 not 1.500, 0 not 0.0)
    s = f"{float(n):.3f}".rstrip("0").rstrip(".")
    return s if s else "0"


# Full POV camera schema. forward/height/lateral = eye offset (model-local);
# pitch/yaw/roll/fov in degrees; dof/vignette/fog are 0..1 effect strengths.
POV_KEYS = ["forward", "height", "lateral", "pitch", "yaw", "roll", "fov", "dof", "vignette", "fog"]
# Defaults that, if a field equals them, are omitted to keep the JSON tidy.
POV_DEFAULTS = {"lateral": 0, "pitch": 0, "yaw": 0, "roll": 0, "fov": 45, "dof": 0, "vignette": 0, "fog": 0}


def pov_line(vals):
    parts = []
    for k in POV_KEYS:
        v = vals.get(k)
        if v is None:
            continue
        if k in POV_DEFAULTS and abs(float(v) - POV_DEFAULTS[k]) < 1e-9:
            continue  # drop no-op fields (forward/height always kept)
        parts.append(f'"{k}": {fmt(v)}')
    return '  "pov": { ' + ", ".join(parts) + ' },'


def patch_pov(path, vals):
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    line = pov_line(vals)
    if re.search(r'(?m)^\s*"pov"\s*:.*$', text):
        text = re.sub(r'(?m)^\s*"pov"\s*:.*$', line, text, count=1)
    else:
        # insert after sizeScale if present, else after the id line
        anchor = re.search(r'(?m)^(\s*"sizeScale"\s*:.*)$', text) or \
                 re.search(r'(?m)^(\s*"id"\s*:.*)$', text)
        if not anchor:
            raise ValueError("no id/sizeScale line to anchor pov insertion")
        text = text[:anchor.end()] + "\n" + line + text[anchor.end():]
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.rstrip("/") != "/save-pov":
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            cid = str(req.get("id", ""))
            if not ID_RE.match(cid):
                return self._send(400, {"error": "bad id"})
            path = os.path.join(ROOT, "config", "species", cid + ".json")
            if not os.path.isfile(path):
                return self._send(404, {"error": "no such species: " + cid})
            vals = {k: req[k] for k in POV_KEYS if k in req and req[k] is not None}
            if "forward" not in vals or "height" not in vals:
                return self._send(400, {"error": "forward and height required"})
            patch_pov(path, vals)
            print("saved pov  " + cid + ": " + " ".join(f"{k}={fmt(v)}" for k, v in vals.items()))
            return self._send(200, {"ok": True, "id": cid, "pov": {k: fmt(v) for k, v in vals.items()}})
        except Exception as e:
            return self._send(500, {"error": str(e)})

    def log_message(self, *a):
        pass  # quiet (we print our own save lines)


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"editor server: serving {ROOT} on http://localhost:{PORT}  (POST /save-pov enabled)")
    httpd.serve_forever()
