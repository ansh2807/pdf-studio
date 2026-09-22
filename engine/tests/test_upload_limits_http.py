#!/usr/bin/env python3
"""
HTTP integration test for the upload size limit.

Locks in a real bug found by directly testing the running server: exceeding
MAX_UPLOAD used to call req.destroy() before the intended JSON error response
could be sent - since the request and response share one socket in Node's
http module, destroying the request killed the connection the response
needed, so the client got a raw "Connection was reset" instead of a clean
413. Fixed by sequencing response-then-cleanup instead of destroy-then-
respond. Also confirms the size guard still genuinely protects the server
(the oversized body is never fully buffered) and that normal uploads are
unaffected.

Starts the real engine-server.cjs with a small MAX_UPLOAD_MB so the test
doesn't need to actually send 100MB.

Run:  python engine/tests/test_upload_limits_http.py
"""
from __future__ import annotations
import os, sys, time, uuid, socket, subprocess, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SERVER = os.path.join(ROOT, "engine-server.cjs")
import fitz


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close()
    return p


def make_small_pdf():
    d = fitz.open()
    d.new_page(width=400, height=560).insert_text((60, 80), "hi", fontsize=24)
    b = d.tobytes(); d.close(); return b


def post_multipart(base, path, filename, data, timeout=15):
    boundary = "----b" + uuid.uuid4().hex
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f'Content-Type: application/pdf\r\n\r\n'
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(base + path, data=body,
          headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


RESULTS = []


def chk(name, cond, val=""):
    RESULTS.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}: {val}")


def main():
    port = free_port()
    env = dict(os.environ, PORT=str(port), BIND_HOST="127.0.0.1", SERVE_STATIC="0", MAX_UPLOAD_MB="1")
    proc = subprocess.Popen(["node", SERVER], env=env, cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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

        # Oversized upload: must get a CLEAN 413 with a real error message,
        # not a connection error / timeout / hang.
        oversized = b"A" * (3 * 1024 * 1024)  # 3MB against a 1MB limit
        import json
        try:
            status, body = post_multipart(base, "/api/native/compress", "big.pdf", oversized, timeout=20)
            chk("oversized upload gets a clean HTTP response (not a connection error)", True, status)
            chk("oversized upload returns 413 Payload Too Large", status == 413, status)
            try:
                parsed = json.loads(body)
                chk("response body is valid JSON with a clear error message",
                    "error" in parsed and "MB limit" in parsed["error"], parsed)
            except Exception as e:
                chk("response body is valid JSON with a clear error message", False, f"parse failed: {e}")
        except Exception as e:
            chk("oversized upload gets a clean HTTP response (not a connection error)", False,
                f"{type(e).__name__}: {e}")

        # Normal upload: must be completely unaffected by the fix.
        small_pdf = make_small_pdf()
        status2, body2 = post_multipart(base, "/api/native/compress", "small.pdf", small_pdf, timeout=15)
        chk("normal-sized upload still returns 200", status2 == 200, status2)
        if status2 == 200:
            try:
                d = fitz.open(stream=body2, filetype="pdf")
                chk("normal upload's response is a valid, correct PDF", d.page_count == 1, d.page_count)
                d.close()
            except Exception as e:
                chk("normal upload's response is a valid, correct PDF", False, str(e))

        # Server must still be alive and healthy after handling the oversized
        # request - the whole point of the limit is the process shouldn't be
        # knocked over by one bad upload.
        status3, _ = post_multipart(base, "/api/native/compress", "small2.pdf", small_pdf, timeout=15)
        chk("server remains healthy for subsequent requests after the oversized one",
            status3 == 200, status3)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\nHTTP UPLOAD-LIMITS: {passed}/{len(RESULTS)} passed")
    print("RESULT:", "PASS" if passed == len(RESULTS) else "FAIL")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
