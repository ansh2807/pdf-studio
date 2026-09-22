#!/usr/bin/env python3
"""
HTTP integration test for POST /api/native/redact-regions.

Locks in a real, serious bug found and fixed this session: the editor's
toolbar "Redact" tool only drew an opaque black rectangle over the selected
area (client-side, pdf-lib) - the original text underneath stayed fully
intact and extractable by anyone who copy/pastes it or runs the exported PDF
through any text-extraction tool. For a redaction tool specifically that is
not a cosmetic bug, it is a privacy failure: a user "redacting" an SSN or
other sensitive text would ship a PDF that still contains it in full,
plaintext, machine-readable form underneath the black box.

Fixed with a genuine PyMuPDF redaction engine command (add_redact_annot +
apply_redactions, which strips the underlying text/image/vector content, not
just paints over it) and a matching HTTP route. This test starts the real
engine-server.cjs, uploads a real PDF containing a known "sensitive" string,
redacts the region covering it through the real HTTP route, and proves via
direct text extraction that the string is actually gone - while an
unrelated control line outside the redacted region survives untouched.

Run:  python engine/tests/test_redact_http.py
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


def make_probe_pdf(path):
    d = fitz.open()
    p = d.new_page(width=595, height=400)
    p.insert_text((80, 100), "Patient SSN: 123-45-6789", fontsize=16)
    p.insert_text((80, 140), "Non-sensitive line for reference", fontsize=16)
    d.save(path)
    d.close()


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
    probe = os.path.join(WORK, "redact_probe.pdf")
    make_probe_pdf(probe)

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
        chk("status reports redactRegions feature", feat.get("redactRegions") is True, feat.get("redactRegions"))

        with open(probe, "rb") as f:
            pdf_bytes = f.read()
        c = Client(base + "/api/native")

        # Box drawn over just the SSN line, exactly as captured from a real
        # drag in the running editor (fraction of the page: top-left origin,
        # y-down - matches PyMuPDF's page.rect convention directly).
        regions = json.dumps([{"page": 0, "rect": [0.1176, 0.205, 0.5210, 0.280]}])
        st, body, headers = c.post(
            "/redact-regions",
            {"file": ("redact_probe.pdf", pdf_bytes, "application/pdf")},
            {"regions": regions},
        )
        chk("route returns 200", st == 200, st)
        out = os.path.join(WORK, "redact_http_result.pdf")
        if st == 200:
            with open(out, "wb") as f:
                f.write(body)
            doc = fitz.open(out)
            text = doc[0].get_text()
            doc.close()
            chk("redacted text is genuinely gone, not just painted over",
                "123-45-6789" not in text and "SSN" not in text, repr(text))
            chk("unrelated control line outside the box survives untouched",
                "Non-sensitive line for reference" in text, repr(text))
            report_b64 = headers.get("X-Engine-Report")
            chk("X-Engine-Report header present", bool(report_b64))

        # No regions supplied must be rejected, not silently processed.
        st2, body2, _ = c.post("/redact-regions", {"file": ("redact_probe.pdf", pdf_bytes, "application/pdf")}, {})
        chk("missing regions rejected with 400", st2 == 400, st2)

        # A region on a page index that doesn't exist must not crash the server.
        bad_regions = json.dumps([{"page": 5, "rect": [0.1, 0.1, 0.5, 0.2]}])
        st3, body3, _ = c.post(
            "/redact-regions",
            {"file": ("redact_probe.pdf", pdf_bytes, "application/pdf")},
            {"regions": bad_regions},
        )
        chk("out-of-range page index handled without a server error", st3 == 200, st3)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\nHTTP REDACT-REGIONS: {passed}/{len(RESULTS)} passed")
    print("RESULT:", "PASS" if passed == len(RESULTS) else "FAIL")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
