#!/usr/bin/env python3
"""
HTTP integration test for the compute-heavy-route rate limiter.

The AI proxy had a rate limiter; the deep-learning routes (photo-watermark-
remove, background-remove) and Office/HTML conversion did not, despite being
the most CPU-expensive operations in the server (7-25s of inference each) and
reachable cross-origin thanks to the wildcard CORS this server sends - any
website could embed hidden requests to exhaust a deployed instance. Verifies
the new limiter actually gates the right routes and leaves everything else
alone, using the real HTTP server (not just the RateLimiter class in
isolation, which is already unit-tested elsewhere).

Run:  python engine/tests/test_compute_ratelimit_http.py
"""
from __future__ import annotations
import os, sys, time, uuid, socket, subprocess, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SERVER = os.path.join(ROOT, "engine-server.cjs")


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close()
    return p


def post_multipart(base, path, filename, data, ctype="image/png", timeout=15):
    boundary = "----b" + uuid.uuid4().hex
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f'Content-Type: {ctype}\r\n\r\n'
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(base + path, data=body,
          headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers)


RESULTS = []


def chk(name, cond, val=""):
    RESULTS.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}: {val}")


def make_tiny_png():
    # Minimal valid PNG bytes (1x1 transparent pixel) - the route only needs
    # to accept the request and hit the rate limiter, not produce a perfect
    # segmentation for this test.
    return bytes.fromhex(
        "89504e470d0a1a0a0000000d494844520000000100000001080600000"
        "01f15c4890000000a4944415478da6360000002000155000dfaf9c00"
        "0000049454e44ae426082"
    )


def main():
    port = free_port()
    env = dict(os.environ, PORT=str(port), BIND_HOST="127.0.0.1", SERVE_STATIC="0",
              COMPUTE_RATE_CAPACITY="3", COMPUTE_RATE_PER_MIN="3")
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

        png = make_tiny_png()

        # Gated route: capacity 3, so requests 1-3 should be let through to the
        # HANDLER (may still fail for other reasons - e.g. no model bundled in
        # this dev environment - but must NOT be 429), request 4 must be 429.
        statuses = []
        for i in range(4):
            status, headers = post_multipart(base, "/api/native/background-remove", "t.png", png)
            statuses.append(status)
        chk("first 3 requests to a gated route are NOT rate-limited",
            all(s != 429 for s in statuses[:3]), statuses[:3])
        chk("4th rapid request to the gated route IS rate-limited (429)",
            statuses[3] == 429, statuses[3])

        # Same check for the other gated route (shares the SAME limiter/bucket
        # per IP, so it should already be exhausted from the calls above).
        status5, _ = post_multipart(base, "/api/native/photo-watermark-remove", "t.png", png)
        chk("a DIFFERENT gated route shares the same per-IP budget (already exhausted)",
            status5 == 429, status5)

        # Ungated route must be completely unaffected, even after exhausting
        # the compute limiter above.
        import fitz
        d = fitz.open(); d.new_page(width=200, height=200); pdf_bytes = d.tobytes(); d.close()
        ok_count = 0
        for i in range(5):
            status, _ = post_multipart(base, "/api/native/compress", "t.pdf", pdf_bytes, ctype="application/pdf")
            if status == 200:
                ok_count += 1
        chk("an UNGATED route (compress) is unaffected by the compute limiter",
            ok_count == 5, f"{ok_count}/5 succeeded")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\nHTTP COMPUTE-RATELIMIT: {passed}/{len(RESULTS)} passed")
    print("RESULT:", "PASS" if passed == len(RESULTS) else "FAIL")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
