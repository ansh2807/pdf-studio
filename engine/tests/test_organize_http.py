#!/usr/bin/env python3
"""
HTTP integration test for the organize routes.

Starts the real engine-server.cjs on a throwaway port, POSTs genuine
multipart/form-data uploads to /api/native/{merge,split,extract,rotate,delete,
reorder}, and verifies the returned files by reading page markers back. This
covers the wiring that the pure-Python engine tests do not: multipart parsing,
the merge multi-file handler, zip streaming, and error status codes.

Requires Node.js on PATH. Run:  python engine/tests/test_organize_http.py
"""
from __future__ import annotations
import io, os, sys, time, uuid, socket, subprocess, urllib.request, urllib.error, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SERVER = os.path.join(ROOT, "engine-server.cjs")
import fitz


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close()
    return p


def mkpdf(markers):
    d = fitz.open()
    for k in markers:
        pg = d.new_page(width=400, height=560)
        pg.insert_text((60, 80), f"MARKER-{k}", fontsize=24)
    b = d.tobytes(); d.close(); return b


def seq_and_rot(b):
    d = fitz.open(stream=b, filetype="pdf")
    out, rots = [], []
    for i in range(d.page_count):
        t = d[i].get_text()
        m = [int(x.split("-")[1]) for x in t.split() if x.startswith("MARKER-")]
        out.append(m[0] if m else None)
        rots.append(d[i].rotation)
    d.close(); return out, rots


class Client:
    def __init__(self, base):
        self.base = base

    def post(self, path, files, fields=None):
        boundary = "----b" + uuid.uuid4().hex
        parts = []
        for name, (fn, data) in files.items():
            parts.append((f'--{boundary}\r\nContent-Disposition: form-data; '
                          f'name="{name}"; filename="{fn}"\r\n'
                          f'Content-Type: application/pdf\r\n\r\n').encode() + data + b"\r\n")
        for k, v in (fields or {}).items():
            parts.append((f'--{boundary}\r\nContent-Disposition: form-data; '
                          f'name="{k}"\r\n\r\n{v}\r\n').encode())
        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)
        req = urllib.request.Request(self.base + path, data=body,
              headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        try:
            r = urllib.request.urlopen(req, timeout=60)
            return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()


RESULTS = []


def chk(name, cond, val=""):
    RESULTS.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}: {val}")


def main():
    port = free_port()
    env = dict(os.environ, PORT=str(port), BIND_HOST="127.0.0.1", SERVE_STATIC="0")
    proc = subprocess.Popen(["node", SERVER], env=env, cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    try:
        # wait for health
        up = False
        for _ in range(50):
            try:
                if urllib.request.urlopen(base + "/healthz", timeout=2).status == 200:
                    up = True; break
            except Exception:
                time.sleep(0.2)
        if not up:
            print("  FAIL  server did not start"); return 1

        c = Client(base + "/api/native")
        src = mkpdf([1, 2, 3, 4, 5]); a = mkpdf([1, 2]); b = mkpdf([3, 4, 5])

        st, body = c.post("/merge", {"f0": ("a.pdf", a), "f1": ("b.pdf", b)})
        chk("merge", st == 200 and seq_and_rot(body)[0] == [1, 2, 3, 4, 5], st)

        st, body = c.post("/rotate", {"f": ("s.pdf", src)}, {"ranges": "1,3", "angle": "90"})
        ids, rots = seq_and_rot(body) if st == 200 else ([], [])
        chk("rotate", st == 200 and ids == [1, 2, 3, 4, 5] and rots == [90, 0, 90, 0, 0], (ids, rots))

        st, body = c.post("/delete", {"f": ("s.pdf", src)}, {"ranges": "2,4"})
        chk("delete", st == 200 and seq_and_rot(body)[0] == [1, 3, 5], st)

        st, body = c.post("/extract", {"f": ("s.pdf", src)}, {"ranges": "5,1"})
        chk("extract-order", st == 200 and seq_and_rot(body)[0] == [5, 1], st)

        st, body = c.post("/reorder", {"f": ("s.pdf", src)}, {"order": "5,4,3,2,1"})
        chk("reorder", st == 200 and seq_and_rot(body)[0] == [5, 4, 3, 2, 1], st)

        st, body = c.post("/split", {"f": ("s.pdf", src)}, {"every": "2"})
        segs = []
        if st == 200:
            z = zipfile.ZipFile(io.BytesIO(body))
            for n in sorted(z.namelist()):
                segs.append(seq_and_rot(z.read(n))[0])
        chk("split-every2", st == 200 and segs == [[1, 2], [3, 4], [5]], segs)

        st, body = c.post("/merge", {"f0": ("a.pdf", a)})
        chk("merge-needs-2", st == 400, st)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\nHTTP ORGANIZE: {passed}/{len(RESULTS)} passed")
    print("RESULT:", "PASS" if passed == len(RESULTS) else "FAIL")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
