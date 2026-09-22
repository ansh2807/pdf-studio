#!/usr/bin/env python3
"""
HTTP integration test for POST /api/native/ocr and /api/native/ocr-pdf.

The editor's "OCR Page" button used to run tesseract.js in the browser: it
downloaded its WASM core and language data from a CDN (so it simply failed
offline or behind a proxy) and recognised the VIEWER CANVAS - the page at
whatever zoom happened to be on screen, un-deskewed. These routes move the job
to the real engine, and this suite proves the whole chain through the actual
HTTP server, not just the Python:

  * /api/native/status advertises the OCR feature and names the engine.
  * /ocr on an image-only PDF (a scan) returns real words with boxes.
  * /ocr on a PDF that already HAS text short-circuits to the text layer -
    exact text instead of a guess, and no wasted inference.
  * /ocr with a language no installed engine covers returns 422 + a flag, so
    the front-end can fall back to the browser engine instead of erroring.
  * /ocr-pdf returns a PDF that is genuinely searchable afterwards, with the
    original scan image still on the page.

Run:  python engine/tests/test_ocr_http.py
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

import cv2
import fitz
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SERVER = os.path.join(ROOT, "engine-server.cjs")
WORK = os.path.join(HERE, "proof")

SCAN_LINES = [
    ((60, 120), 26, "INVOICE 2024-0871"),
    ((60, 180), 16, "Northwind Trading Company"),
    ((60, 210), 16, "Ames, IA 50010"),
    ((60, 270), 16, "Amount due: 1,284.50"),
]


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    return port


def make_text_pdf(path):
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    for point, size, text in SCAN_LINES:
        page.insert_text(point, text, fontsize=size, fontname="helv")
    doc.save(path)
    doc.close()


def make_scan_pdf(path, dpi=200):
    """Text PDF -> pixels -> image-only PDF. This is what a scan looks like:
    no text layer at all, which is exactly when OCR has to do the work."""
    source = os.path.join(WORK, "_ocr_text_source.pdf")
    make_text_pdf(source)
    doc = fitz.open(source)
    pix = doc[0].get_pixmap(dpi=dpi, alpha=False)
    png = pix.tobytes("png")
    doc.close()
    out = fitz.open()
    page = out.new_page(width=595, height=842)
    page.insert_image(page.rect, stream=png)
    out.save(path)
    out.close()


class Client:
    def __init__(self, base):
        self.base = base

    def post(self, path, files, fields=None, timeout=600):
        boundary = "----b" + uuid.uuid4().hex
        parts = []
        for name, (filename, data, ctype) in files.items():
            parts.append((f'--{boundary}\r\nContent-Disposition: form-data; '
                          f'name="{name}"; filename="{filename}"\r\n'
                          f'Content-Type: {ctype}\r\n\r\n').encode() + data + b"\r\n")
        for key, value in (fields or {}).items():
            parts.append((f'--{boundary}\r\nContent-Disposition: form-data; '
                          f'name="{key}"\r\n\r\n{value}\r\n').encode())
        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)
        req = urllib.request.Request(
            self.base + path, data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
            return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), {}


RESULTS = []


def chk(name, cond, val=""):
    RESULTS.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}: {val}")


def main():
    os.makedirs(WORK, exist_ok=True)
    scan = os.path.join(WORK, "ocr_scan_probe.pdf")
    textual = os.path.join(WORK, "ocr_text_probe.pdf")
    make_scan_pdf(scan)
    make_text_pdf(textual)

    with fitz.open(scan) as doc:
        chk("probe scan really has no text layer", len(doc[0].get_text().strip()) == 0,
            repr(doc[0].get_text()[:40]))

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
                    up = True
                    break
            except Exception:
                time.sleep(0.2)
        if not up:
            print("  FAIL  server did not start")
            return 1

        status = json.loads(urllib.request.urlopen(base + "/api/native/status", timeout=30).read())
        features = status.get("features", {})
        chk("status advertises the ocr feature", features.get("ocr") is True, features.get("ocr"))
        chk("status advertises the ocrPdf feature", features.get("ocrPdf") is True, features.get("ocrPdf"))
        chk("status names the OCR engine", bool(status.get("ocrEngine")), status.get("ocrEngine"))
        chk("status lists OCR languages", bool(status.get("ocrLanguages")),
            (status.get("ocrLanguages") or [])[:6])
        if not features.get("ocr"):
            print("  (no server OCR engine installed - remaining checks skipped)")
            return 1

        client = Client(base + "/api/native")
        scan_bytes = open(scan, "rb").read()
        text_bytes = open(textual, "rb").read()

        # ---- 1. a real scan ------------------------------------------------ #
        st, body, _ = client.post("/ocr", {"file": ("scan.pdf", scan_bytes, "application/pdf")},
                                  {"page": "1", "lang": "eng"})
        chk("/ocr returns 200 on a scanned page", st == 200, st)
        result = json.loads(body) if st == 200 else {}
        if st == 200:
            text = result.get("text", "").replace(" ", "").lower()
            chk("/ocr recognised the invoice number", "2024-0871" in text, result.get("text", "")[:60])
            chk("/ocr recognised the company", "northwindtrading" in text, result.get("text", "")[:80])
            chk("/ocr returned word boxes", len(result.get("words", [])) >= 10,
                len(result.get("words", [])))
            chk("/ocr reports the engine that ran", bool(result.get("engine")), result.get("engine"))
            chk("/ocr reports the image size the boxes belong to",
                result.get("width", 0) > 0 and result.get("height", 0) > 0,
                (result.get("width"), result.get("height")))
            boxes_ok = all(
                0 <= w["bbox"]["x0"] <= w["bbox"]["x1"] <= result["width"] + 1 and
                0 <= w["bbox"]["y0"] <= w["bbox"]["y1"] <= result["height"] + 1
                for w in result.get("words", [])
            )
            chk("/ocr boxes are inside the reported image", boxes_ok)
            chk("/ocr confidence is reported per word",
                all("confidence" in w for w in result.get("words", [])),
                result.get("meanConfidence"))

        # ---- 2. a page that already has text -------------------------------- #
        st2, body2, _ = client.post("/ocr", {"file": ("text.pdf", text_bytes, "application/pdf")},
                                    {"page": "1", "lang": "eng"})
        chk("/ocr returns 200 on a text-layer page", st2 == 200, st2)
        if st2 == 200:
            textual_result = json.loads(body2)
            chk("/ocr uses the exact text layer instead of guessing",
                textual_result.get("backend") == "text-layer", textual_result.get("engine"))
            chk("text-layer path is 100% confident",
                textual_result.get("meanConfidence") == 100.0, textual_result.get("meanConfidence"))
            chk("text-layer path returns the real text",
                "2024-0871" in textual_result.get("text", ""), textual_result.get("text", "")[:50])

        # ---- 3. forcing recognition over an existing text layer ------------- #
        st3, body3, _ = client.post("/ocr", {"file": ("text.pdf", text_bytes, "application/pdf")},
                                    {"page": "1", "lang": "eng", "forceOcr": "1"})
        if st3 == 200:
            forced = json.loads(body3)
            chk("forceOcr actually runs the recogniser", forced.get("backend") != "text-layer",
                forced.get("engine"))

        # ---- 4. a language nothing installed can do ------------------------- #
        installed = set(status.get("ocrLanguages") or [])
        missing = next((code for code in ("hin", "tam", "ben", "urd") if code not in installed), None)
        if missing:
            st4, body4, _ = client.post("/ocr", {"file": ("scan.pdf", scan_bytes, "application/pdf")},
                                        {"page": "1", "lang": missing})
            chk("unsupported language returns 422, not 500", st4 == 422, st4)
            if st4 == 422:
                payload = json.loads(body4)
                chk("422 is flagged so the browser engine can take over",
                    payload.get("unsupportedLanguage") is True, payload.get("error"))

        # ---- 5. whole document -> searchable PDF ---------------------------- #
        st5, body5, headers5 = client.post(
            "/ocr-pdf", {"file": ("scan.pdf", scan_bytes, "application/pdf")}, {"lang": "eng"})
        chk("/ocr-pdf returns 200", st5 == 200, st5)
        if st5 == 200:
            out = os.path.join(WORK, "ocr_http_searchable.pdf")
            with open(out, "wb") as handle:
                handle.write(body5)
            doc = fitz.open(out)
            page = doc[0]
            extracted = page.get_text()
            hits = page.search_for("INVOICE")
            images = len(page.get_images(full=True))
            doc.close()
            chk("the scan is searchable afterwards", len(extracted.strip()) > 20,
                extracted[:60].replace("\n", " | "))
            chk("search finds a known word in the scan", len(hits) >= 1, hits[:1])
            chk("the original scan image is still on the page", images >= 1, images)
            chk("/ocr-pdf reports what it did", bool(headers5.get("X-Engine-Report")))

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()

    print("\n" + "=" * 62)
    failed = [name for name, ok in RESULTS if not ok]
    for name, ok in RESULTS:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    print("=" * 62)
    print("OVERALL:", "PASS" if not failed else f"FAIL ({len(failed)})")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
