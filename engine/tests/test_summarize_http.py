#!/usr/bin/env python3
"""
HTTP integration test for POST /api/native/summarize - the local, no-API-key
document intelligence engine wired through the real HTTP route.

Run:  python engine/tests/test_summarize_http.py
"""
from __future__ import annotations
import os, sys, time, uuid, socket, subprocess, urllib.request, urllib.error, json
import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SERVER = os.path.join(ROOT, "engine-server.cjs")
WORK = os.path.join(HERE, "proof")


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close()
    return p


class Client:
    def __init__(self, base):
        self.base = base

    def post(self, path, files, fields=None):
        boundary = "----b" + uuid.uuid4().hex
        parts = []
        for name, (fn, data, ctype) in files.items():
            parts.append((f'--{boundary}\r\nContent-Disposition: form-data; '
                          f'name="{name}"; filename="{fn}"\r\n'
                          f'Content-Type: {ctype}\r\n\r\n').encode() + data + b"\r\n")
        for k, v in (fields or {}).items():
            parts.append((f'--{boundary}\r\nContent-Disposition: form-data; '
                          f'name="{k}"\r\n\r\n{v}\r\n').encode())
        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)
        req = urllib.request.Request(self.base + path, data=body,
              headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        try:
            r = urllib.request.urlopen(req, timeout=60)
            return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), {}


RESULTS = []


def chk(name, cond, val=""):
    RESULTS.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}: {val}")


def main():
    os.makedirs(WORK, exist_ok=True)
    probe = os.path.join(WORK, "summarize_probe.pdf")
    d = fitz.open()
    p = d.new_page(width=595, height=500)
    text = (
        "Climate change is one of the most pressing challenges facing humanity today. "
        "Rising global temperatures are causing polar ice caps to melt. "
        "The company picnic was rescheduled to next Friday due to rain. "
        "Extreme weather events are becoming more frequent due to climate change. "
        "Renewable energy is critical to addressing climate change. "
        "Contact billing@paradoxworld.cc for the invoice dated 2026-03-15, total $4,500.00."
    )
    p.insert_textbox(fitz.Rect(40, 40, 555, 450), text, fontsize=11)
    d.save(probe); d.close()

    port = free_port()
    env = dict(os.environ, PORT=str(port), BIND_HOST="127.0.0.1", SERVE_STATIC="0")
    proc = subprocess.Popen(["node", SERVER], env=env, cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    base = f"http://127.0.0.1:{port}"
    try:
        up = False
        for _ in range(50):
            try:
                if urllib.request.urlopen(base + "/healthz", timeout=2).status == 200:
                    up = True; break
            except Exception:
                time.sleep(0.2)
        if not up:
            print("  FAIL  server did not start"); return 1

        status = urllib.request.urlopen(base + "/api/native/status", timeout=10).read()
        feat = json.loads(status).get("features", {})
        chk("status reports summarize feature", feat.get("summarize") is True, feat.get("summarize"))

        c = Client(base + "/api/native")
        with open(probe, "rb") as f:
            st, body, headers = c.post(
                "/summarize", {"file": ("probe.pdf", f.read(), "application/pdf")}, {"sentences": "3"},
            )
        chk("route returns 200", st == 200, st)
        result = json.loads(body) if st == 200 else {}
        chk("summary mentions the real recurring theme", "climate change" in result.get("summary", "").lower(), result.get("summary"))
        chk("summary drops the tangential picnic sentence", "picnic" not in result.get("summary", ""))
        keywords = [k["term"] for k in result.get("keywords", [])]
        chk("top keyword is the recurring theme, not a one-off word", keywords[:1] == ["climate"], keywords[:5])
        entities = result.get("entities", {})
        chk("date entity extracted from a real PDF", "2026-03-15" in entities.get("dates", []), entities.get("dates"))
        chk("money entity extracted from a real PDF", any("4,500.00" in a for a in entities.get("amounts", [])), entities.get("amounts"))
        chk("email entity extracted from a real PDF", "billing@paradoxworld.cc" in entities.get("emails", []), entities.get("emails"))
        chk("readability block present", "fleschScore" in result.get("readability", {}), result.get("readability"))

        # Missing file must be rejected, not silently processed.
        st2, _, _ = c.post("/summarize", {})
        chk("missing file rejected with 400", st2 == 400, st2)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\nHTTP SUMMARIZE: {passed}/{len(RESULTS)} passed")
    print("RESULT:", "PASS" if passed == len(RESULTS) else "FAIL")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
