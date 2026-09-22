#!/usr/bin/env python3
"""
HTTP integration test for POST /api/native/photo-watermark-remove.

Starts the real engine-server.cjs on a throwaway port, uploads a genuine
synthetic-watermarked PNG (ground truth known, same technique as
test_photo_watermark.py) with a crop-rect, and verifies the SERVER round trip:
multipart parsing, the rect-to-mask CLI wiring, and real recovery quality on
the returned image - not just "the route didn't crash".

Requires Node.js + the engine's Python deps (cv2, numpy) on PATH.
Run:  python engine/tests/test_photowatermark_http.py
"""
from __future__ import annotations
import io, os, sys, time, uuid, socket, subprocess, urllib.request, urllib.error, math
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SERVER = os.path.join(ROOT, "engine-server.cjs")


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close()
    return p


def make_watermarked_png():
    """Same synthesis technique as test_photo_watermark.py: known background,
    known semi-transparent mark, so we can measure real recovery quality."""
    H = W = 256
    rng = np.random.RandomState(11)
    noise = cv2.resize(cv2.resize(rng.rand(H, W).astype(np.float32), (W // 4, H // 4)), (W, H))
    bg = np.stack([noise * 120 + 40, noise * 160 + 30, noise * 90 + 20], -1).astype(np.uint8)

    mask = np.zeros((H, W), np.uint8)
    cv2.putText(mask, "SAMPLE", (20, 140), cv2.FONT_HERSHEY_DUPLEX, 1.6, 255, 3, cv2.LINE_AA)
    ys, xs = np.where(mask > 0)
    x0, x1 = int(xs.min()) - 10, int(xs.max()) + 10
    y0, y1 = int(ys.min()) - 10, int(ys.max()) + 10

    alpha, color = 0.45, np.array([255, 255, 255], np.float32)
    wm = bg.astype(np.float32).copy()
    m = mask > 0
    wm[m] = alpha * color + (1 - alpha) * wm[m]
    wm = np.clip(wm, 0, 255).astype(np.uint8)

    ok, buf = cv2.imencode(".png", wm)
    assert ok
    return buf.tobytes(), bg, (x0, y0, x1 - x0, y1 - y0)


def psnr(a, b):
    a = a.astype(np.float64); b = b.astype(np.float64)
    mse = float(np.mean((a - b) ** 2))
    if mse < 1e-9:
        return 99.0
    return 10.0 * math.log10((255.0 ** 2) / mse)


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

        # Confirm the capability probe reports photoWatermark now that cv2/numpy
        # are detected - this is what the front end gates on.
        status = urllib.request.urlopen(base + "/api/native/status", timeout=10).read()
        import json as _json
        feat = _json.loads(status).get("features", {})
        chk("status reports photoWatermark feature", feat.get("photoWatermark") is True, feat.get("photoWatermark"))

        png_bytes, ground_truth, (x, y, w, h) = make_watermarked_png()
        c = Client(base + "/api/native")

        st, body, headers = c.post(
            "/photo-watermark-remove",
            {"file": ("wm.png", png_bytes, "image/png")},
            {"x": str(x), "y": str(y), "w": str(w), "h": str(h)},
        )
        chk("route returns 200", st == 200, st)
        if st == 200:
            arr = np.frombuffer(body, np.uint8)
            result = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            chk("returned bytes decode as a valid image", result is not None and result.shape[:2] == (256, 256))
            if result is not None:
                mask = np.zeros((256, 256), np.uint8)
                mask[y:y + h, x:x + w] = 255
                p = psnr(ground_truth[mask > 0], result[mask > 0])
                # This is the flagship claim: real recovery, not a blur. Same
                # bar as the offline engine test (mean was 36.7dB there).
                chk("recovered region closely matches true original (>=25dB)", p >= 25.0, f"{p:.1f}dB")
            report_b64 = headers.get("X-Engine-Report")
            chk("X-Engine-Report header present", bool(report_b64))

        # Missing rect fields must be rejected, not silently processed.
        st2, body2, _ = c.post("/photo-watermark-remove", {"file": ("wm.png", png_bytes, "image/png")}, {})
        chk("missing rect rejected with 400", st2 == 400, st2)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\nHTTP PHOTO-WATERMARK: {passed}/{len(RESULTS)} passed")
    print("RESULT:", "PASS" if passed == len(RESULTS) else "FAIL")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
