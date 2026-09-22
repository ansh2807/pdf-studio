#!/usr/bin/env python3
"""
Tests for the content-aware image re-encoding added to cmd_compress
(_classify_and_encode_image in engine.py): grayscale scans get encoded as
true single-channel grayscale instead of wasting 2/3 their data on absent
color, and flat-color graphics (screenshots, line art, diagrams) get encoded
losslessly instead of forced into JPEG, where block artifacts are most
visible right at their sharp edges.

Locks in a real bug found while building this: `Document.update_stream`
defaults to `compress=1`, which silently Flate-wraps whatever bytes it's
given - corrupting an already-JPEG-encoded stream (the object's /Filter key
said /DCTDecode, but the actual bytes on disk became zlib(jpeg), not jpeg;
MuPDF correctly refused to decode it: "Not a JPEG file", the stream literally
started with the zlib header 0x78 0xda). Only showed up for SOME images, not
all, because update_stream's implicit re-compression only kept the
double-wrapped result when it happened to be smaller - which depended on the
specific image's byte content. Fixed by passing compress=0 explicitly, since
this code has already chosen and finalized the exact encoding itself.

Uses genuinely high-resolution synthetic source images (2400x2600, drawn at
600x650pt - about 288 effective DPI) so the "medium" compress level's 150 DPI
threshold actually triggers re-encoding, matching a real oversized scan.

Run:  python engine/tests/test_compress_content_aware.py
"""
from __future__ import annotations
import os, sys, subprocess
import numpy as np
from PIL import Image
import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
ENGINE = os.path.join(ROOT, "engine.py")
WORK = os.path.join(HERE, "proof")

RESULTS = []


def chk(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}  {detail}")


def build_test_doc(path, w=2400, h=2600):
    rng = np.random.RandomState(3)
    gray_arr = (rng.rand(h, w) * 255).astype("uint8")
    gray_img = Image.fromarray(np.stack([gray_arr] * 3, axis=-1))

    graphic = np.zeros((h, w, 3), dtype="uint8")
    graphic[: h // 2, :] = [255, 255, 255]
    graphic[h // 2 :, :] = [37, 99, 235]
    graphic[h // 3 : h // 2, w // 3 : w // 2] = [220, 38, 38]
    graphic_img = Image.fromarray(graphic)

    yy, xx = np.mgrid[0:h, 0:w]
    photo = np.zeros((h, w, 3), dtype="uint8")
    photo[..., 0] = xx / w * 255
    photo[..., 1] = yy / h * 255
    photo[..., 2] = ((np.sin(xx / 120) + 1) * 127).astype("uint8")
    noise = (rng.rand(h, w, 3) * 20).astype("uint8")
    photo = np.clip(photo.astype(int) + noise, 0, 255).astype("uint8")
    photo_img = Image.fromarray(photo)

    doc = fitz.open()
    for img, label in [(gray_img, "gray"), (graphic_img, "graphic"), (photo_img, "photo")]:
        import io as _io
        buf = _io.BytesIO()
        img.save(buf, format="PNG")
        p = doc.new_page(width=600, height=650)
        p.insert_text((10, 20), label, fontsize=14)
        p.insert_image(fitz.Rect(0, 40, 600, 640), stream=buf.getvalue())
    doc.save(path)
    doc.close()


def main():
    os.makedirs(WORK, exist_ok=True)
    src = os.path.join(WORK, "compress_ca_test.pdf")
    out = os.path.join(WORK, "compress_ca_result.pdf")
    build_test_doc(src)

    proc = subprocess.run(
        [sys.executable, ENGINE, "compress", "--input", src, "--output", out, "--level", "medium"],
        capture_output=True, text=True,
    )
    try:
        import json
        report = json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        report = {}

    chk("command succeeds", report.get("ok") is True, (proc.stdout, proc.stderr))
    chk("all three images actually get re-encoded (DPI threshold triggers)", report.get("downsampledImages") == 3, report)
    chk("the grayscale image is classified as grayscale", report.get("grayscaleImages") == 1, report)
    chk("the flat graphic is classified as graphic", report.get("graphicImages") == 1, report)
    chk("the gradient photo is classified as photo", report.get("photoImages") == 1, report)
    chk("the file actually shrinks a lot (oversized source)", report.get("savedPct", 0) > 90, report.get("savedPct"))

    # ---------- the real bug: every page must open and render without MuPDF
    # rejecting a stream whose bytes don't match its own Filter key ----------
    doc = fitz.open(out)
    chk("output has all 3 pages", doc.page_count == 3, doc.page_count)
    for i in range(doc.page_count):
        try:
            pix = doc[i].get_pixmap(dpi=72)
            chk(f"page {i} renders without a MuPDF decode error", pix.width > 0 and pix.height > 0)
        except Exception as exc:
            chk(f"page {i} renders without a MuPDF decode error", False, str(exc))

    # ---------- verify each image was actually re-encoded as claimed, not
    # just labeled that way in the report ----------
    for i, expect_colorspace in enumerate(["DeviceGray", "DeviceRGB", "DeviceRGB"]):
        xref = doc[i].get_images(full=True)[0][0]
        raw = doc.xref_object(xref)
        chk(f"page {i} object dict declares {expect_colorspace}", f"/{expect_colorspace}" in raw, raw[:200])
        stream = doc.xref_stream_raw(xref)
        if "/DCTDecode" in raw:
            chk(f"page {i}: DCTDecode-filtered bytes are really a JPEG (SOI marker), not double-wrapped",
                stream[:2] == b"\xff\xd8", stream[:4])
        else:
            chk(f"page {i}: FlateDecode-filtered bytes are really zlib, not a raw JPEG mislabeled",
                stream[:2] == b"x\xda", stream[:4])
    doc.close()

    passed = sum(1 for _, ok in RESULTS if ok)
    total = len(RESULTS)
    print(f"\nCOMPRESS CONTENT-AWARE: {passed}/{total} passed")
    print("RESULT:", "PASS" if passed == total else "FAIL")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
