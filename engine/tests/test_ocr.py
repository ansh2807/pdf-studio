#!/usr/bin/env python3
"""
OCR engine tests (engine/ocr/ocr_engine.py).

Covers the failure this engine was written to fix: "OCR Page" in the editor ran
tesseract.js in the browser, against the viewer canvas, with CDN-downloaded
language data - so it produced nothing offline, and near-garbage on a real
scan even when it did run (screen-resolution input, no deskew, no contrast
work).

What is proved here:
  * A page-image-only PDF (no text layer at all - a scan) comes back as real,
    correct words with high confidence.
  * Word boxes land on the words: each box is verified against the position
    the text was actually drawn at, not just "some box exists".
  * A SKEWED scan still reads correctly, and its boxes are reported in the
    ORIGINAL (un-deskewed) image's coordinate space - the mapping that makes
    the editor's boxes line up with what the user sees.
  * Missing spaces are recovered from the pixels (PP-OCR's recognition model
    has no space class, so "Ames, IA" comes back as "Ames,IA" without this).
  * A language no installed engine covers is reported as exactly that, so the
    caller can fall back to the browser instead of showing a dead end.

Run:  python engine/tests/test_ocr.py
"""
from __future__ import annotations

import os
import sys

import cv2
import fitz
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "engine"))
WORK = os.path.join(HERE, "proof")

from ocr import ocr_engine  # noqa: E402

RESULTS = []


def chk(name, cond, val=""):
    RESULTS.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}: {val}")


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
LINES = [
    ((60, 120), 26, "INVOICE 2024-0871"),
    ((60, 180), 16, "Northwind Trading Company"),
    ((60, 210), 16, "Ames, IA 50010"),
    ((60, 270), 16, "Amount due: 1,284.50"),
    ((60, 300), 16, "Due date: 03/14/2026"),
]


def make_scan_image(angle=0.0, dpi=200):
    """A page rendered to pixels - i.e. a scan. No text layer survives this."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    for point, size, text in LINES:
        page.insert_text(point, text, fontsize=size, fontname="helv")
    pix = page.get_pixmap(dpi=dpi, alpha=False)
    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    doc.close()
    if angle:
        h, w = img.shape[:2]
        matrix = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        img = cv2.warpAffine(img, matrix, (w, h), flags=cv2.INTER_CUBIC,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
    return img


def words_of(result):
    return [w["text"] for w in result["words"]]


def find_word(result, needle):
    for word in result["words"]:
        if needle.lower() in word["text"].lower():
            return word
    return None


# --------------------------------------------------------------------------- #
def test_availability():
    caps = ocr_engine.capabilities()
    chk("an OCR engine is installed", caps["available"], caps.get("engineName"))
    chk("capabilities lists usable languages", bool(caps["languages"]), caps["languages"][:6])
    return caps["available"]


def test_flat_scan():
    img = make_scan_image()
    result = ocr_engine.recognize(img, lang="eng")
    chk("recognition succeeds on a scan", result.get("ok"), result.get("error", ""))
    if not result.get("ok"):
        return None
    text = result["text"].lower().replace(" ", "")
    chk("reads the invoice number", "2024-0871" in text, result["text"][:60])
    chk("reads the company name", "northwindtrading" in text, result["text"][:80])
    chk("reads the amount", "1,284.50" in text or "1.284.50" in text, result["text"])
    chk("reads the date", "03/14/2026" in text, result["text"])
    chk("mean confidence is high", result["meanConfidence"] >= 80, result["meanConfidence"])
    chk("reports which engine ran", bool(result["engine"]), result["engine"])
    return result


def test_word_boxes(result):
    """Boxes must sit on the words, not merely exist.

    The reference is where the text was actually drawn: line 1 of LINES is at
    y=120pt on a 842pt page rendered at 200 DPI, so its top edge lands at
    about 120/842 of the image height. A box that is off by a line - the class
    of bug that makes the editor put an edit box on the wrong row - fails this.
    """
    if not result:
        return
    height = result["height"]
    width = result["width"]
    invoice = find_word(result, "INVOICE")
    chk("the word INVOICE has its own box", invoice is not None, invoice and invoice["text"])
    if invoice:
        top_fraction = invoice["bbox"]["y0"] / height
        # Drawn at baseline y=120 of 842 -> ~0.143; the glyph box sits just above.
        chk("INVOICE box is on the first line", 0.10 <= top_fraction <= 0.16, round(top_fraction, 3))
        chk("INVOICE box starts at the left margin",
            0.05 <= invoice["bbox"]["x0"] / width <= 0.16, round(invoice["bbox"]["x0"] / width, 3))
        chk("INVOICE box has sane size",
            invoice["bbox"]["x1"] > invoice["bbox"]["x0"] and invoice["bbox"]["y1"] > invoice["bbox"]["y0"],
            invoice["bbox"])

    due = find_word(result, "50010")
    if due:
        chk("a later line's box is below an earlier line's box",
            invoice is None or due["bbox"]["y0"] > invoice["bbox"]["y1"],
            (invoice and invoice["bbox"]["y1"], due["bbox"]["y0"]))

    inside = all(
        0 <= w["bbox"]["x0"] <= w["bbox"]["x1"] <= width + 1 and
        0 <= w["bbox"]["y0"] <= w["bbox"]["y1"] <= height + 1
        for w in result["words"]
    )
    chk("every box is inside the image bounds", inside, f"{width}x{height}")


def test_word_splitting(result):
    """Words must be individually editable, and spaces must survive.

    Whole-line boxes would force a user to retype a whole line to fix one
    misread word, and a missing space ("Ames,IA") is the PP-OCR recognition
    model's known behaviour that `ink_runs` exists to undo.
    """
    if not result:
        return
    words = words_of(result)
    chk("text is split into separate words, not lines",
        len(words) >= 12, f"{len(words)} words")
    chk("no word contains a space", all(" " not in w for w in words), words[:6])
    joined = " ".join(words)
    chk("the city/state line kept its space", "Ames," in joined and "IA" in joined,
        [w for w in words if "Ames" in w or w == "IA"])


def test_deskew():
    """A 2.5-degree scan must read correctly AND report boxes in the original
    image's coordinate space (the editor draws on the un-rotated page)."""
    angle = 2.5
    img = make_scan_image(angle=angle)
    result = ocr_engine.recognize(img, lang="eng")
    chk("recognition succeeds on a skewed scan", result.get("ok"), result.get("error", ""))
    if not result.get("ok"):
        return
    text = result["text"].lower().replace(" ", "")
    chk("skewed scan still reads the invoice number", "2024-0871" in text, result["text"][:60])
    chk("skew was detected and corrected", abs(result["skewAngle"]) >= 1.0, result["skewAngle"])

    height, width = img.shape[:2]
    chk("skewed-scan boxes are reported against the original image size",
        result["width"] == width and result["height"] == height,
        (result["width"], result["height"], width, height))
    invoice = find_word(result, "INVOICE")
    if invoice:
        # The page was rotated about its centre, so the first line moves, but
        # not by much at 2.5 degrees. If the inverse mapping were skipped or
        # applied the wrong way round, this lands far outside.
        top_fraction = invoice["bbox"]["y0"] / height
        chk("skewed INVOICE box maps back near the first line",
            0.05 <= top_fraction <= 0.25, round(top_fraction, 3))


def test_space_recovery_unit():
    """`ink_runs` in isolation: two ink blobs separated by a real gap must come
    back as two runs, and letters inside one word must not be split."""
    line = np.full((40, 300), 255, np.uint8)
    cv2.putText(line, "Ames,", (5, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, 0, 2)
    cv2.putText(line, "IA", (170, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, 0, 2)
    runs = ocr_engine.ink_runs(line)
    chk("ink_runs finds two words across a real space", len(runs) == 2, runs)

    tight = np.full((40, 300), 255, np.uint8)
    cv2.putText(tight, "Amesia", (5, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, 0, 2)
    runs_tight = ocr_engine.ink_runs(tight)
    chk("ink_runs does not split inside one word", len(runs_tight) == 1, runs_tight)


def test_split_line_prefers_recognised_spaces():
    """When the recogniser emits spaces they are authoritative - the pixels are
    only consulted for the no-space case."""
    bbox = {"x0": 0.0, "y0": 0.0, "x1": 200.0, "y1": 20.0}
    words = ocr_engine.split_line_into_words("Due date: 03/14/2026", None, bbox, 90.0)
    chk("recognised spaces drive the split", [w["text"] for w in words] == ["Due", "date:", "03/14/2026"],
        [w["text"] for w in words])
    chk("each word gets a box inside the line", all(
        bbox["x0"] - 0.01 <= w["bbox"]["x0"] <= w["bbox"]["x1"] <= bbox["x1"] + 0.01 for w in words),
        [w["bbox"] for w in words])


def test_unsupported_language():
    """A language nothing installed can do must say so - not return junk."""
    caps = ocr_engine.capabilities()
    missing = next((code for code in ("hin", "tam", "ben", "urd")
                    if code not in caps["languages"]), None)
    if missing is None:
        chk("(skipped) every probe language is installed", True, caps["languages"][:8])
        return
    img = make_scan_image()
    result = ocr_engine.recognize(img, lang=missing)
    chk("unsupported language is refused, not guessed", result.get("ok") is False, result.get("error"))
    chk("refusal is flagged so the caller can fall back",
        result.get("unsupportedLanguage") is True, result.get("unsupportedLanguage"))
    chk("refusal lists what IS available", bool(result.get("languages")), result.get("languages", [])[:6])


def main():
    os.makedirs(WORK, exist_ok=True)
    print("OCR engine:", ocr_engine.capabilities().get("engineName"))
    if not test_availability():
        print("\n  No OCR engine installed - install rapidocr-onnxruntime "
              "(see requirements.txt) or a native tesseract binary.")
        return 1
    result = test_flat_scan()
    test_word_boxes(result)
    test_word_splitting(result)
    test_deskew()
    test_space_recovery_unit()
    test_split_line_prefers_recognised_spaces()
    test_unsupported_language()

    if result:
        # Leave a human-readable artifact next to the other suites' proof.
        with open(os.path.join(WORK, "ocr_scan_text.txt"), "w", encoding="utf-8") as handle:
            handle.write(result["text"])

    print("\n" + "=" * 62)
    failed = [name for name, ok in RESULTS if not ok]
    for name, ok in RESULTS:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    print("=" * 62)
    print("OVERALL:", "PASS" if not failed else f"FAIL ({len(failed)})")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
