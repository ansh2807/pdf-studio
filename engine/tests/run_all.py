#!/usr/bin/env python3
"""
Single entry point for the engine test suite. Exits non-zero if ANY suite fails,
so it can gate a deploy / CI run.

    python engine/tests/run_all.py
"""
import os, sys, subprocess, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SUITES = [
    "test_engine_ops.py",       # compress/repair/unlock/protect/convert/render
    "test_compress_content_aware.py",  # content-aware image re-encoding (grayscale/graphic/photo) in compress
    "test_report_reconstruction.py", # spacing-delimited invoice/report -> Excel/Word column reconstruction
    "test_organize.py",         # merge/split/extract/rotate/delete/reorder (engine)
    "test_organize_http.py",    # same, end-to-end through the HTTP server
    "test_photowatermark_http.py", # photo watermark engine wired through the real HTTP route
    "test_redact_http.py",      # true region redaction (strips content, not a painted-over box) via real HTTP route
    "test_compare_http.py",     # real page-aligned, word-level diff (not bag-of-words) via real HTTP route
    "test_summarize.py",        # local document intelligence (TextRank summary/keywords/entities), unit-level
    "test_summarize_http.py",   # same, wired through the real HTTP route - no AI API key needed
    "test_ocr.py",              # OCR engine: scan -> words+boxes, deskew, space recovery, language routing
    "test_ocr_http.py",         # OCR wired through the real HTTP routes (/ocr and /ocr-pdf)
    "test_bg_removal.py",       # background removal (U2Net) - real subject segmentation
    "test_bgremoval_http.py",   # background removal wired through the real HTTP route
    "test_upload_limits_http.py", # oversized-upload rejection sends a clean response, not a connection reset
    "test_compute_ratelimit_http.py", # deep-learning/conversion routes are rate-limited (previously only AI proxy was)
    "test_pdf_watermark.py",    # PDF text-watermark classifier
    "test_photo_watermark.py",  # photo watermark recovery (matte + inpaint)
    "test_lama_inpaint.py",     # LaMa deep-inpainting tier (skips gracefully if model/onnxruntime absent)
]
# Front-end pure-logic suites run under Node.
JS_SUITES = [
    "test_pagerange_js.mjs",    # browser Extract/Split/Remove page-range parser
    "test_pdfmerge_js.mjs",     # multi-file Open + Merge button (page order)
    "test_pageops_js.mjs",      # insert/delete/duplicate/move + annotation remap
    "test_textboxes_js.mjs",    # Edit-text / OCR box geometry + click hit-test
    "test_shapegeometry_js.mjs", # canvas shapes: move/resize/nudge/duplicate + export transform
    "test_textlayout_js.mjs",   # text->PDF word-wrap/pagination (conversion tools)
    "test_croprect_js.mjs",     # Photo Studio crop/resize/preset math
    "test_smoothpath_js.mjs",   # signature/pen stroke smoothing (RDP simplify + Catmull-Rom spline)
    "test_sizebudget_js.mjs",   # KB-budget quality/shrink search (passport/govt presets)
    "test_ratelimiter_js.mjs",  # AI-proxy abuse guard
    "test_safename_js.mjs",     # upload-filename sanitizer (confirmed path-confinement bypass fix)
    "test_aiphotosettings_js.mjs", # Photo Studio AI-enhance response parsing (honest success reporting)
]


def main():
    results = []
    for s in SUITES:
        path = os.path.join(HERE, s)
        print("\n" + "#" * 70)
        print("# " + s)
        print("#" * 70)
        rc = subprocess.run([sys.executable, path]).returncode
        results.append((s, rc == 0))
    node = shutil.which("node")
    for s in JS_SUITES:
        path = os.path.join(HERE, s)
        print("\n" + "#" * 70)
        print("# " + s + ("" if node else "  (SKIPPED - node not found)"))
        print("#" * 70)
        if not node:
            results.append((s + " (skipped)", True))
            continue
        rc = subprocess.run([node, path]).returncode
        results.append((s, rc == 0))
    print("\n" + "=" * 70)
    for s, ok in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {s}")
    all_ok = all(ok for _, ok in results)
    print("=" * 70)
    print("OVERALL:", "PASS" if all_ok else "FAIL")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
