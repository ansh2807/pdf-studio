#!/usr/bin/env python3
"""
PDF text-watermark classifier test.

Builds PDFs where we KNOW which text is a watermark and which is legitimate
content (big headings, grey captions, body text), runs the auto detector, and
asserts: every watermark instance is flagged, and NO legitimate text is.

This directly targets the old bug: `is_big OR is_light` redacted real headings
and grey captions. The new scorer must not.

Run:  python engine/tests/test_pdf_watermark.py
"""
import sys, os, io
import fitz  # PyMuPDF

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
import engine as E  # noqa: E402


def build_pdf(path, *, watermark="CONFIDENTIAL", pages=4, rotated=True,
              light=True, add_big_heading=True, add_grey_caption=True):
    doc = fitz.open()
    for p in range(pages):
        page = doc.new_page(width=595, height=842)  # A4
        # legitimate body text
        page.insert_text((72, 120), "This is normal body paragraph text that "
                         "should always survive.", fontsize=11, color=(0, 0, 0))
        page.insert_text((72, 140), "Second line of ordinary content here.",
                         fontsize=11, color=(0, 0, 0))
        if add_big_heading:
            # a LARGE dark heading - old code's is_big would eat this
            page.insert_text((72, 90), "Quarterly Report", fontsize=28,
                             color=(0, 0, 0))
        if add_grey_caption:
            # a light-grey caption - old code's is_light would eat this
            page.insert_text((72, 160), "figure 1: light grey caption text",
                             fontsize=9, color=(0.6, 0.6, 0.6))
        # the watermark: repeated on every page, light + optionally rotated.
        # Arbitrary angles need morph (a pivot + rotation matrix); insert_text's
        # own `rotate` only accepts 0/90/180/270.
        col = (0.8, 0.8, 0.8) if light else (0.1, 0.1, 0.1)
        pivot = fitz.Point(150, 500)
        if rotated:
            morph = (pivot, fitz.Matrix(-45))  # 45 deg
        else:
            morph = None
        page.insert_text(pivot, watermark, fontsize=40, color=col, morph=morph)
    doc.save(path)
    doc.close()


class Args:
    def __init__(self, inp, out):
        self.input = inp; self.output = out
        self.mode = "auto"; self.text = None
        self.pages = None; self.page = 0; self.rect = None


def extract_all_text(path):
    doc = fitz.open(path)
    t = "\n".join(doc[i].get_text() for i in range(doc.page_count))
    doc.close()
    return t


def run_case(name, **kw):
    tmp = os.path.join(os.path.dirname(__file__), "proof")
    os.makedirs(tmp, exist_ok=True)
    src = os.path.join(tmp, f"wmpdf_{name}_in.pdf")
    dst = os.path.join(tmp, f"wmpdf_{name}_out.pdf")
    wm = kw.get("watermark", "CONFIDENTIAL")
    build_pdf(src, **kw)

    # capture emitted report
    import json
    captured = {}
    orig_emit = E.emit
    E.emit = lambda payload, code=0: captured.update(payload)
    try:
        E.cmd_remove_watermark(Args(src, dst))
    finally:
        E.emit = orig_emit

    before = extract_all_text(src)
    after = extract_all_text(dst)

    wm_gone = wm.lower() not in after.lower()
    body_kept = "normal body paragraph" in after.lower()
    heading_kept = ("quarterly report" in after.lower()) if kw.get("add_big_heading", True) else True
    caption_kept = ("light grey caption" in after.lower()) if kw.get("add_grey_caption", True) else True

    ok = wm_gone and body_kept and heading_kept and caption_kept
    print(f"[{name:22}] wm_removed={wm_gone} body_kept={body_kept} "
          f"heading_kept={heading_kept} caption_kept={caption_kept} "
          f"removed={captured.get('textInstancesRemoved',0)} -> {'PASS' if ok else 'FAIL'}")
    if not ok:
        print("     candidates:", captured.get("textCandidates"))
    return ok


def run():
    results = []
    results.append(run_case("rotated_light", rotated=True, light=True))
    results.append(run_case("rotated_dark", rotated=True, light=False))
    results.append(run_case("horizontal_light", rotated=False, light=True))
    results.append(run_case("no_heading_caption", add_big_heading=False,
                            add_grey_caption=False))
    # Control: a doc with NO watermark - detector must remove nothing legitimate.
    tmp = os.path.join(os.path.dirname(__file__), "proof")
    src = os.path.join(tmp, "wmpdf_control_in.pdf")
    dst = os.path.join(tmp, "wmpdf_control_out.pdf")
    d = fitz.open()
    for p in range(3):
        pg = d.new_page(width=595, height=842)
        pg.insert_text((72, 90), "Annual Summary", fontsize=26, color=(0, 0, 0))
        pg.insert_text((72, 130), "Body text that must be preserved intact.",
                       fontsize=11, color=(0, 0, 0))
        pg.insert_text((72, 150), "small grey footnote here", fontsize=8,
                       color=(0.6, 0.6, 0.6))
    d.save(src); d.close()
    captured = {}
    orig = E.emit
    E.emit = lambda payload, code=0: captured.update(payload)
    try:
        E.cmd_remove_watermark(Args(src, dst))
    finally:
        E.emit = orig
    after = extract_all_text(dst)
    control_ok = ("annual summary" in after.lower()
                  and "body text that must be preserved" in after.lower()
                  and "grey footnote" in after.lower()
                  and captured.get("textInstancesRemoved", 0) == 0)
    print(f"[{'control_no_watermark':22}] nothing_removed="
          f"{captured.get('textInstancesRemoved',0)==0} all_kept="
          f"{'annual summary' in after.lower()} -> {'PASS' if control_ok else 'FAIL'}")
    results.append(control_ok)

    ok = all(results)
    print("\nRESULT:", "PASS" if ok else "FAIL", f"({sum(results)}/{len(results)})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(run())
