#!/usr/bin/env python3
"""
Core engine operations test harness.

Drives engine.py exactly as engine-server.cjs does - as a subprocess CLI that
emits one JSON line - across every PDF operation under multiple input
conditions, and asserts on the real output files (valid PDF? text preserved?
smaller? encrypted? right page count? valid docx/xlsx/pptx/zip?).

This is the "test each small thing under many conditions" pass for the engine's
back end. Front-end canvas tools (shapes, text, ink, stamps) are exercised
separately in the browser; this covers the server-side heavy operations.

Run:  python engine/tests/test_engine_ops.py
"""
from __future__ import annotations
import io, os, sys, json, subprocess, zipfile, tempfile, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
ENGINE = os.path.join(ROOT, "engine.py")
WORK = os.path.join(HERE, "_ops_work")

import fitz  # PyMuPDF


# --------------------------------------------------------------------------- #
# Fixture builders (each returns a path)
# --------------------------------------------------------------------------- #
def _new(name):
    return os.path.join(WORK, name)


def fx_text(pages=1, name="text.pdf"):
    doc = fitz.open()
    for i in range(pages):
        pg = doc.new_page(width=595, height=842)
        pg.insert_text((72, 100), f"Page {i+1}: the quick brown fox jumps over "
                       "the lazy dog.", fontsize=12)
        pg.insert_text((72, 130), "Second paragraph with more selectable text "
                       "content here.", fontsize=12)
    p = _new(name); doc.save(p); doc.close(); return p


def fx_image_heavy(name="imgheavy.pdf"):
    """A page dominated by a large high-res photo-like image (compress target)."""
    import numpy as np
    from PIL import Image
    rng = np.random.RandomState(7)
    arr = (rng.rand(1600, 2200, 3) * 255).astype("uint8")  # noisy = poorly compressible
    # add smooth gradient so it's photo-like, not pure noise
    yy, xx = np.mgrid[0:1600, 0:2200]
    arr[..., 0] = (arr[..., 0] * 0.3 + (xx / 2200 * 255) * 0.7).astype("uint8")
    buf = io.BytesIO(); Image.fromarray(arr).save(buf, format="JPEG", quality=95)
    doc = fitz.open()
    pg = doc.new_page(width=595, height=842)
    pg.insert_text((72, 60), "Report with a big embedded photo below.", fontsize=12)
    pg.insert_image(fitz.Rect(40, 80, 555, 760), stream=buf.getvalue())
    p = _new(name); doc.save(p, deflate=True); doc.close(); return p


def fx_table(name="table.pdf"):
    doc = fitz.open()
    pg = doc.new_page(width=595, height=842)
    pg.insert_text((72, 60), "ITEM WISE SALES SUMMARY", fontsize=13)
    # a ruled table
    cols = [72, 260, 360, 460, 540]
    rows = [100, 130, 160, 190, 220]
    for x in cols:
        pg.draw_line((x, rows[0]), (x, rows[-1]))
    for y in rows:
        pg.draw_line((cols[0], y), (cols[-1], y))
    hdr = ["DESCRIPTION", "QTY", "RATE", "AMOUNT"]
    for j, h in enumerate(hdr):
        pg.insert_text((cols[j] + 4, rows[0] + 18), h, fontsize=9)
    data = [["Widget A", "10", "5.00", "50.00"], ["Gadget B", "3", "12.50", "37.50"]]
    for r, row in enumerate(data):
        for j, cell in enumerate(row):
            pg.insert_text((cols[j] + 4, rows[r + 1] + 18), cell, fontsize=9)
    p = _new(name); doc.save(p); doc.close(); return p


def fx_encrypted(user_pw="open123", owner_pw="owner999", name="enc.pdf"):
    doc = fitz.open()
    pg = doc.new_page(width=595, height=842)
    pg.insert_text((72, 100), "Secret content behind a password.", fontsize=12)
    p = _new(name)
    perm = int(fitz.PDF_PERM_ACCESSIBILITY)  # very restricted
    doc.save(p, encryption=fitz.PDF_ENCRYPT_AES_256,
             user_pw=user_pw, owner_pw=owner_pw, permissions=perm)
    doc.close(); return p


def fx_damaged(name="damaged.pdf"):
    base = fx_text(3, "predamage.pdf")
    data = open(base, "rb").read()
    # Corrupt the xref by truncating the trailer; keep body so recovery can work.
    cut = data[: int(len(data) * 0.82)]
    p = _new(name); open(p, "wb").write(cut); return p


# --------------------------------------------------------------------------- #
# Engine runner
# --------------------------------------------------------------------------- #
def run_engine(command, **flags):
    argv = [sys.executable, ENGINE, command]
    for k, v in flags.items():
        if v is None:
            continue
        argv.append("--" + k.replace("_", "-"))
        if v is not True:
            argv.append(str(v))
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=180)
    out = proc.stdout.strip().splitlines()
    payload = {}
    for line in reversed(out):
        line = line.strip()
        if line.startswith("{"):
            try:
                payload = json.loads(line); break
            except Exception:
                continue
    return proc.returncode, payload, proc.stderr


def pdf_ok(path, min_pages=1):
    try:
        d = fitz.open(path)
        n = d.page_count; d.close()
        return n >= min_pages
    except Exception:
        return False


def pdf_text(path):
    try:
        d = fitz.open(path)
        t = "\n".join(d[i].get_text() for i in range(d.page_count)); d.close()
        return t
    except Exception:
        return ""


# --------------------------------------------------------------------------- #
# Test cases
# --------------------------------------------------------------------------- #
RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}   {detail}")


def test_compress():
    print("\n[compress] four levels on an image-heavy PDF")
    src = fx_image_heavy()
    before = os.path.getsize(src)
    for level in ("light", "medium", "strong", "extreme"):
        out = _new(f"cmp_{level}.pdf")
        rc, pay, err = run_engine("compress", input=src, output=out, level=level)
        after = os.path.getsize(out) if os.path.exists(out) else 0
        smaller = 0 < after <= before
        valid = pdf_ok(out)
        text_kept = "big embedded photo" in pdf_text(out).lower()
        # medium+ should actually shrink an image-heavy file
        shrink_ok = smaller if level in ("medium", "strong", "extreme") else valid
        check(f"compress/{level}", valid and shrink_ok and text_kept,
              f"{round(before/1024)}KB->{round(after/1024)}KB saved={pay.get('savedPct')}%")


def test_repair():
    print("\n[repair] on a truncated/damaged PDF")
    src = fx_damaged()
    out = _new("repaired.pdf")
    rc, pay, err = run_engine("repair", input=src, output=out)
    check("repair/damaged", pdf_ok(out), f"engine={pay.get('engine')} note={pay.get('note','')[:40]}")


def test_unlock():
    print("\n[unlock] correct password, and wrong-password refusal")
    src = fx_encrypted()
    # correct password
    out = _new("unlocked.pdf")
    rc, pay, err = run_engine("unlock", input=src, output=out, password="open123")
    ok_dec = pdf_ok(out) and "secret content" in pdf_text(out).lower()
    check("unlock/correct-pw", ok_dec, f"wasEncrypted={pay.get('wasEncrypted')}")
    # wrong password -> must NOT produce output, must signal needsPassword
    out2 = _new("unlocked_wrong.pdf")
    if os.path.exists(out2):
        os.remove(out2)
    rc, pay, err = run_engine("unlock", input=src, output=out2, password="WRONG")
    refused = pay.get("needsPassword") is True or pay.get("ok") is False
    check("unlock/wrong-pw-refused", refused and not os.path.exists(out2),
          f"needsPassword={pay.get('needsPassword')}")


def test_protect():
    print("\n[protect] encrypt, then verify it needs the password")
    src = fx_text(1, "toprotect.pdf")
    out = _new("protected.pdf")
    rc, pay, err = run_engine("protect", input=src, output=out, password="lockme123")
    # opening without password should fail; with password should work
    needs_pw = False
    try:
        fitz.open(out).authenticate("")  # noqa
        d = fitz.open(out)
        needs_pw = d.needs_pass
        d.close()
    except Exception:
        needs_pw = True
    opens_with = False
    try:
        d = fitz.open(out)
        opens_with = bool(d.authenticate("lockme123"))
        d.close()
    except Exception:
        opens_with = False
    check("protect/encrypted", os.path.exists(out) and needs_pw and opens_with,
          f"needs_pass={needs_pw} opens_with_pw={opens_with}")


def test_pdfa():
    print("\n[pdfa] rebuild")
    src = fx_text(2, "forpdfa.pdf")
    out = _new("out_pdfa.pdf")
    rc, pay, err = run_engine("pdfa", input=src, output=out)
    check("pdfa/valid", pdf_ok(out, 2) and "quick brown fox" in pdf_text(out).lower(),
          f"engine={pay.get('engine')}")


def test_pdf_to_images():
    print("\n[pdf-to-images] png and jpg, page count must match")
    src = fx_text(10, "for_imgs.pdf")
    for fmt in ("png", "jpg"):
        out = _new(f"imgs_{fmt}.zip")
        rc, pay, err = run_engine("pdf-to-images", input=src, output=out,
                                  img_format=fmt, dpi=120)
        n = 0
        try:
            with zipfile.ZipFile(out) as z:
                names = z.namelist()
                n = len(names)
                first_ok = names and names[0].lower().endswith(fmt if fmt == "png" else "jpg")
        except Exception:
            first_ok = False
        check(f"pdf-to-images/{fmt}", n == 10 and first_ok,
              f"pages={pay.get('pages')} entries={n}")


def test_office_exports():
    print("\n[pdf-to-word / excel / ppt]")
    tbl = fx_table()
    txt = fx_text(2, "for_office.pdf")
    # word
    out = _new("out.docx")
    rc, pay, err = run_engine("pdf-to-word", input=txt, output=out)
    docx_ok = _is_zip_with(out, "word/document.xml")
    check("pdf-to-word/docx", docx_ok, f"engine={pay.get('engine')}")
    # excel from a ruled table
    out = _new("out.xlsx")
    rc, pay, err = run_engine("pdf-to-excel", input=tbl, output=out)
    xlsx_ok = _is_zip_with(out, "xl/workbook.xml")
    check("pdf-to-excel/xlsx", xlsx_ok, f"engine={pay.get('engine')} tables={pay.get('tables')}")
    # ppt
    out = _new("out.pptx")
    rc, pay, err = run_engine("pdf-to-ppt", input=txt, output=out)
    pptx_ok = _is_zip_with(out, "ppt/presentation.xml")
    check("pdf-to-ppt/pptx", pptx_ok, f"engine={pay.get('engine')}")


def test_page_png():
    print("\n[page-png] single page rasterization")
    src = fx_text(3, "for_png.pdf")
    out = _new("page2.png")
    rc, pay, err = run_engine("page-png", input=src, output=out, page=1, dpi=110)
    ok = os.path.exists(out) and open(out, "rb").read(8) == b"\x89PNG\r\n\x1a\n"
    check("page-png/valid-png", ok, f"bytes={os.path.getsize(out) if os.path.exists(out) else 0}")


def _is_zip_with(path, member_substr):
    try:
        with zipfile.ZipFile(path) as z:
            return any(member_substr in n for n in z.namelist())
    except Exception:
        return False


def main():
    if os.path.isdir(WORK):
        shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK, exist_ok=True)

    test_compress()
    test_repair()
    test_unlock()
    test_protect()
    test_pdfa()
    test_pdf_to_images()
    test_office_exports()
    test_page_png()

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    total = len(RESULTS)
    print("\n" + "=" * 66)
    print(f"ENGINE OPS: {passed}/{total} passed")
    fails = [n for n, ok, _ in RESULTS if not ok]
    if fails:
        print("FAILED:", ", ".join(fails))
    print("RESULT:", "PASS" if passed == total else "FAIL")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
