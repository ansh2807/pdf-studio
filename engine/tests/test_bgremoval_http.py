#!/usr/bin/env python3
"""
HTTP integration test for POST /api/native/background-remove.

Starts the real engine-server.cjs on a throwaway port, uploads the real
reference photo, and verifies the SERVER round trip for both modes:
transparent PNG and solid-color composite - real bytes over real HTTP, not
just the Python function in isolation.

Run:  python engine/tests/test_bgremoval_http.py
"""
from __future__ import annotations
import os, sys, time, uuid, socket, subprocess, urllib.request, urllib.error
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SERVER = os.path.join(ROOT, "engine-server.cjs")
REF_IMAGE = os.path.join(HERE, "proof", "ref_image.jpg")
MODEL_PATH = os.path.join(ROOT, "engine", "models", "u2net.onnx")


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
    if not os.path.isfile(MODEL_PATH):
        print(f"SKIP: model not found at {MODEL_PATH} (optional dependency)")
        return 0
    if not os.path.isfile(REF_IMAGE):
        print(f"SKIP: reference photo not found at {REF_IMAGE}")
        return 0

    port = free_port()
    env = dict(os.environ, PORT=str(port), BIND_HOST="127.0.0.1", SERVE_STATIC="0")
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

        status = urllib.request.urlopen(base + "/api/native/status", timeout=10).read()
        import json as _json
        feat = _json.loads(status).get("features", {})
        chk("status reports bgRemoval feature", feat.get("bgRemoval") is True, feat.get("bgRemoval"))

        img_bytes = open(REF_IMAGE, "rb").read()
        c = Client(base + "/api/native")

        # transparent mode
        st, body, headers = c.post("/background-remove", {"file": ("photo.jpg", img_bytes, "image/jpeg")})
        chk("transparent route returns 200", st == 200, st)
        if st == 200:
            arr = np.frombuffer(body, np.uint8)
            result = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
            chk("transparent result decodes with an alpha channel",
                result is not None and result.shape[2] == 4,
                result.shape if result is not None else None)
            if result is not None and result.shape[2] == 4:
                alpha = result[..., 3]
                chk("alpha channel has real variation (not fully opaque/transparent)",
                    0 < alpha.mean() < 255, float(alpha.mean()))

        # solid-color composite mode
        st2, body2, _ = c.post("/background-remove", {"file": ("photo.jpg", img_bytes, "image/jpeg")},
                               {"bgColor": "ff0000"})
        chk("solid-color route returns 200", st2 == 200, st2)
        if st2 == 200:
            arr2 = np.frombuffer(body2, np.uint8)
            result2 = cv2.imdecode(arr2, cv2.IMREAD_COLOR)
            chk("solid-color result decodes as a valid image", result2 is not None)
            if result2 is not None:
                corners = np.concatenate([result2[0:5, 0:5].reshape(-1, 3),
                                          result2[-5:, -5:].reshape(-1, 3)])
                # BGR - red target means B,G low and R high
                is_reddish = np.mean((corners[:, 2].astype(int) - corners[:, 0].astype(int)) > 50)
                chk("corners (background) composited toward the requested red",
                    is_reddish > 0.5, f"{is_reddish:.0%} of corner pixels reddish")

        # malformed request
        st3, body3, _ = c.post("/background-remove", {})
        chk("no file uploaded rejected with 400", st3 == 400, st3)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    passed = sum(1 for _, ok in RESULTS if ok)
    print(f"\nHTTP BG-REMOVAL: {passed}/{len(RESULTS)} passed")
    print("RESULT:", "PASS" if passed == len(RESULTS) else "FAIL")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
