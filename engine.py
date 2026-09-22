#!/usr/bin/env python3
"""
Local PDF Studio - professional engine.

A single command-line tool the Node bridge (engine-server.cjs) shells out to.
Every command reads real files from disk and writes real files to disk, then
prints a one-line JSON status object to stdout so the caller can report detail.

Design goals:
  * Never touch the network. Everything runs on this machine.
  * Degrade gracefully: if an optional library is missing, say so in JSON
    instead of crashing, so the browser can fall back to its own engine.
  * Be genuinely lossless where the PDF structure allows it (watermark layers,
    embedded images, encryption) instead of flattening pages to pictures.

Usage:
  python engine.py <command> --input IN [--input2 IN2] --output OUT [options]
  python engine.py capabilities
"""

import argparse
import io
import json
import os
import sys
import zipfile


def emit(payload, code=0):
    """Print a JSON status line and exit."""
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    sys.exit(code)


def fail(message, **extra):
    emit({"ok": False, "error": str(message), **extra}, code=1)


def emit_progress(payload):
    """Print an intermediate JSON line WITHOUT exiting - unlike emit(), the
    caller keeps running. Only cmd_pdf_crack uses this: every other command
    finishes in well under a second, so a single final emit() is enough."""
    sys.stdout.write(json.dumps({"type": "progress", **payload}) + "\n")
    sys.stdout.flush()


# --------------------------------------------------------------------------- #
# Capability probe
# --------------------------------------------------------------------------- #
def probe_capabilities():
    caps = {"python": sys.version.split()[0]}

    def has(mod):
        try:
            __import__(mod)
            return True
        except Exception:
            return False

    caps["pymupdf"] = has("fitz")
    caps["pikepdf"] = has("pikepdf")
    caps["openpyxl"] = has("openpyxl")
    caps["pptx"] = has("pptx")
    caps["docx"] = has("docx")
    caps["pdf2docx"] = has("pdf2docx")
    caps["pillow"] = has("PIL")
    caps["opencv"] = has("cv2")
    caps["numpy"] = has("numpy")
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine"))
        from watermark.photo_watermark import lama_available
        caps["lama"] = bool(lama_available())
    except Exception:
        caps["lama"] = False
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine"))
        from background.remove_bg import bg_removal_available
        caps["bgRemoval"] = bool(bg_removal_available())
    except Exception:
        caps["bgRemoval"] = False
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine"))
        from ocr.ocr_engine import capabilities as ocr_capabilities
        caps["ocr"] = ocr_capabilities()
    except Exception as exc:
        caps["ocr"] = {"available": False, "error": str(exc)}
    if caps["pymupdf"]:
        import fitz
        caps["pymupdf_version"] = fitz.VersionBind
    return caps


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def open_pdf(path):
    import fitz
    return fitz.open(path)


def rect_from_fraction(page, frac):
    """frac = [x0, y0, x1, y1] as 0..1 fractions of the page rect."""
    import fitz
    r = page.rect
    return fitz.Rect(
        r.x0 + frac[0] * r.width,
        r.y0 + frac[1] * r.height,
        r.x0 + frac[2] * r.width,
        r.y0 + frac[3] * r.height,
    )


def page_indices(doc, pages_arg, current):
    if pages_arg == "current" and current is not None:
        idx = current - 1
        if 0 <= idx < doc.page_count:
            return [idx]
        return []
    return list(range(doc.page_count))


# --------------------------------------------------------------------------- #
# Compression
# --------------------------------------------------------------------------- #
def _classify_and_encode_image(pil, quality):
    """Content-aware image re-encoding, not one JPEG quality for everything.

    Two real, common cases a blind quality setting handles badly:

    1. A scanned document photographed/scanned in "color" mode is almost
       always actually grayscale (ink on paper) - encoding it as 3-channel
       RGB JPEG wastes roughly 2/3 of the data on color information that
       isn't there. Detected by sampling pixels and checking R, G, B are
       all nearly equal; re-encoded as true single-channel grayscale JPEG.
    2. A flat-color graphic (a screenshot, a logo, a line-art scan, a
       diagram) has few distinct colors and hard edges - exactly what JPEG's
       block-DCT compression is worst at: it introduces visible ringing and
       blur right at those edges. Detected by counting distinct colors in a
       downsampled sample; re-encoded losslessly (raw zlib-deflated pixel
       data, the same compression a PDF's /FlateDecode filter uses directly
       - not a wrapped PNG file, which is a different container the PDF
       spec's image dictionary does not accept) instead of forced into JPEG.

    Returns (bytes, colorspace, components, filter_name, content_kind) where
    content_kind is "grayscale" / "graphic" / "photo", for reporting.
    """
    import numpy as np
    import zlib
    from PIL import Image

    rgb = pil.convert("RGB")
    arr = np.asarray(rgb)
    step_y = max(1, arr.shape[0] // 48)
    step_x = max(1, arr.shape[1] // 48)
    sample = arr[::step_y, ::step_x]
    channel_diff = (
        np.abs(sample[..., 0].astype(int) - sample[..., 1].astype(int))
        + np.abs(sample[..., 1].astype(int) - sample[..., 2].astype(int))
    ).mean()
    is_grayscale = channel_diff < 3.0

    if is_grayscale:
        gray = pil.convert("L")
        buf = io.BytesIO()
        gray.save(buf, format="JPEG", quality=quality, optimize=True)
        return buf.getvalue(), "DeviceGray", 1, "jpeg", "grayscale"

    sample_img = Image.fromarray(sample) if sample.size else rgb
    distinct_colors = sample_img.getcolors(maxcolors=4096)
    is_flat_graphic = distinct_colors is not None and len(distinct_colors) <= 200

    if is_flat_graphic:
        raw = zlib.compress(rgb.tobytes(), 9)
        buf_jpeg = io.BytesIO()
        rgb.save(buf_jpeg, format="JPEG", quality=max(quality, 82), optimize=True)
        if len(raw) <= len(buf_jpeg.getvalue()):
            return raw, "DeviceRGB", 3, "flate", "graphic"
        return buf_jpeg.getvalue(), "DeviceRGB", 3, "jpeg", "graphic"

    buf = io.BytesIO()
    rgb.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue(), "DeviceRGB", 3, "jpeg", "photo"


def cmd_compress(args):
    import fitz

    levels = {
        "light": {"dpi": 0, "quality": 90},
        "medium": {"dpi": 150, "quality": 75},
        "strong": {"dpi": 110, "quality": 62},
        "extreme": {"dpi": 72, "quality": 48},
    }
    level = levels.get(args.level, levels["medium"])
    target_dpi = level["dpi"]
    quality = level["quality"]

    doc = open_pdf(args.input)
    before = os.path.getsize(args.input)
    downsampled = 0
    content_kinds = {"grayscale": 0, "graphic": 0, "photo": 0}

    if target_dpi:
        try:
            from PIL import Image
            for page in doc:
                pw = max(page.rect.width, 1)
                for info in page.get_images(full=True):
                    xref = info[0]
                    try:
                        raw = doc.extract_image(xref)
                    except Exception:
                        continue
                    if not raw:
                        continue
                    img_w = raw.get("width", 0)
                    img_h = raw.get("height", 0)
                    if not img_w or not img_h:
                        continue
                    # Effective DPI = image pixels across its drawn width.
                    try:
                        bbox = page.get_image_bbox(info)
                        drawn_w_in = max(bbox.width, 1) / 72.0
                    except Exception:
                        drawn_w_in = pw / 72.0
                    eff_dpi = img_w / max(drawn_w_in, 0.01)
                    if eff_dpi <= target_dpi * 1.15:
                        continue
                    scale = target_dpi / eff_dpi
                    new_w = max(1, int(img_w * scale))
                    new_h = max(1, int(img_h * scale))
                    try:
                        pil = Image.open(io.BytesIO(raw["image"]))
                        if pil.mode in ("RGBA", "P", "LA"):
                            pil = pil.convert("RGB")
                        pil = pil.resize((new_w, new_h), Image.LANCZOS)
                        encoded, colorspace, components, fmt, kind = _classify_and_encode_image(pil, quality)
                        # compress=0: update_stream's default (compress=1)
                        # silently Flate-wraps whatever bytes it's given,
                        # which corrupts an already-JPEG-encoded stream (the
                        # Filter key below says /DCTDecode, but the actual
                        # bytes on disk become zlib(jpeg), not jpeg) -
                        # confirmed by reproducing it: MuPDF refused to
                        # decode the result ("Not a JPEG file", the stream
                        # literally started with the zlib header 0x78 0xda).
                        # The raw-Flate "graphic" path needs its own bytes
                        # kept exactly as-is for the same reason, just with
                        # the opposite Filter.
                        doc.update_stream(xref, encoded, compress=0)
                        doc.xref_set_key(xref, "Width", str(new_w))
                        doc.xref_set_key(xref, "Height", str(new_h))
                        doc.xref_set_key(xref, "ColorSpace", f"/{colorspace}")
                        doc.xref_set_key(xref, "BitsPerComponent", "8")
                        doc.xref_set_key(xref, "Filter", "/DCTDecode" if fmt == "jpeg" else "/FlateDecode")
                        for key in ("SMask", "Decode", "DecodeParms"):
                            doc.xref_set_key(xref, key, "null")
                        downsampled += 1
                        content_kinds[kind] += 1
                    except Exception:
                        continue
        except Exception:
            pass

    doc.save(
        args.output,
        garbage=4,
        deflate=True,
        # Images this function re-encoded itself (JPEG via update_stream with
        # Filter=/DCTDecode, or raw zlib via /FlateDecode) must NOT also go
        # through PyMuPDF's own blanket image-deflate pass: it can wrap an
        # already-finalized JPEG stream in an extra zlib layer while leaving
        # the Filter dict saying /DCTDecode, producing a stream whose actual
        # bytes don't match what the Filter claims - confirmed by reproducing
        # it (the saved object's raw bytes started with the zlib header
        # 0x78 0xda while /Filter still read /DCTDecode, and MuPDF correctly
        # refused to decode it: "Not a JPEG file"). Images left untouched at
        # the "light" level have no such conflict, so they still benefit from
        # PyMuPDF's own pass.
        deflate_images=(downsampled == 0),
        deflate_fonts=True,
        clean=True,
    )
    doc.close()
    after = os.path.getsize(args.output)
    emit({
        "ok": True,
        "engine": "pymupdf",
        "level": args.level,
        "beforeKB": round(before / 1024),
        "afterKB": round(after / 1024),
        "downsampledImages": downsampled,
        "grayscaleImages": content_kinds["grayscale"],
        "graphicImages": content_kinds["graphic"],
        "photoImages": content_kinds["photo"],
        "savedPct": round((1 - after / before) * 100) if before else 0,
    })


# --------------------------------------------------------------------------- #
# Repair / linearize
# --------------------------------------------------------------------------- #
def cmd_repair(args):
    try:
        import pikepdf
        pdf = pikepdf.open(args.input, allow_overwriting_input=True)
        pdf.save(args.output, linearize=True, fix_metadata_version=True)
        pdf.close()
        emit({"ok": True, "engine": "pikepdf", "action": "repair+linearize"})
    except Exception as exc:
        # Fall back to a PyMuPDF clean rebuild.
        try:
            doc = open_pdf(args.input)
            doc.save(args.output, garbage=4, clean=True, deflate=True)
            doc.close()
            emit({"ok": True, "engine": "pymupdf", "action": "rebuild",
                  "note": f"pikepdf failed ({exc}); used PyMuPDF rebuild"})
        except Exception as exc2:
            fail(f"repair failed: {exc2}")


# --------------------------------------------------------------------------- #
# Unlock (decrypt / remove restrictions)
# --------------------------------------------------------------------------- #
def cmd_unlock(args):
    import pikepdf
    pw = args.password or ""
    try:
        pdf = pikepdf.open(args.input, password=pw)
    except pikepdf.PasswordError:
        fail("This PDF needs the correct open password.", needsPassword=True)
        return
    except Exception as exc:
        fail(f"Could not open PDF: {exc}")
        return
    was_encrypted = pdf.is_encrypted
    pdf.save(args.output)  # saving without encryption strips it
    pdf.close()
    emit({"ok": True, "engine": "pikepdf", "wasEncrypted": bool(was_encrypted)})


# --------------------------------------------------------------------------- #
# Password recovery (open-password brute force / dictionary attack)
#
# This only ever attacks the PDF's USER (open) password - the one that gates
# viewing the file at all. An owner-only restriction (no open password set)
# is already handled instantly by unlock above; nothing to "crack" there.
#
# A hard combination cap and a wall-clock cap both apply, independent of each
# other: the cap keeps someone from queuing a search that's combinatorially
# infeasible to begin with, and the wall-clock limit keeps a legitimately
# large-but-feasible search from pinning a shared server's CPU indefinitely.
# --------------------------------------------------------------------------- #
CRACK_HARD_CAP_ATTEMPTS = 20_000_000
CRACK_PROGRESS_INTERVAL_SECONDS = 0.5


def _crack_wordlist_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine", "wordlists", "common-passwords.txt")


def _crack_read_wordlist(path, seen, words):
    if not path or not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            w = line.strip()
            if w and w not in seen:
                seen.add(w)
                words.append(w)


def _crack_candidates(args):
    """Return (iterator-of-password-strings, total-count). Fails (exits) if
    the mode's search space exceeds CRACK_HARD_CAP_ATTEMPTS, rather than
    silently truncating - the caller should narrow the request instead."""
    import itertools

    mode = args.crack_mode
    if mode == "pin":
        lo, hi = args.min_len or 4, args.max_len or 8
        if lo < 1 or hi < lo or hi > 12:
            fail("PIN length must be between 1 and 12 digits, with min length <= max length.")
        total = sum(10 ** n for n in range(lo, hi + 1))
        if total > CRACK_HARD_CAP_ATTEMPTS:
            fail(f"That PIN length range is {total:,} combinations - too large for this server. Narrow the range.")

        def gen():
            for n in range(lo, hi + 1):
                for combo in itertools.product("0123456789", repeat=n):
                    yield "".join(combo)
        return gen(), total

    if mode == "dictionary":
        seen = set()
        words = []
        # A user's own uploaded list is almost always their actual best guess
        # (passwords they've used before) - try it before the generic
        # built-in list, not after, so it isn't stuck behind ~5,000 entries.
        _crack_read_wordlist(args.wordlist, seen, words)
        _crack_read_wordlist(_crack_wordlist_path(), seen, words)
        if not words:
            fail("No dictionary available - the built-in word list is missing and no custom word list was uploaded.")
        return iter(words), len(words)

    if mode == "charset":
        charset = "".join(dict.fromkeys(args.charset or ""))  # dedupe, keep order
        if not charset:
            fail("Pick at least one character set (lowercase, uppercase, digits, symbols).")
        lo, hi = args.min_len or 1, args.max_len or 4
        if lo < 1 or hi < lo:
            fail("Invalid length range.")
        total = sum(len(charset) ** n for n in range(lo, hi + 1))
        if total > CRACK_HARD_CAP_ATTEMPTS:
            fail(f"That character set and length range is {total:,} possibilities - too large for this server. "
                 f"Narrow the character set or the length range.")

        def gen():
            for n in range(lo, hi + 1):
                for combo in itertools.product(charset, repeat=n):
                    yield "".join(combo)
        return gen(), total

    fail(f"Unknown recovery mode: {mode}")
    return iter(()), 0  # unreachable; fail() exits, but keeps linters happy


# PDF revision 6 (AES-256, the current standard - anything made in the last
# ~decade) deliberately runs a slow, iterated SHA-256 key derivation on every
# open attempt, the same way bcrypt/PBKDF2 do for passwords - it's slow BY
# DESIGN, specifically to resist brute force. Measured on this machine: ~60
# pikepdf.open() attempts/sec single-threaded against an R6 file, which makes
# even a 4-digit PIN search (10,000 combinations) take minutes, not seconds.
# Each guess is fully independent CPU-bound work, so this parallelizes
# cleanly across cores - capped well under the machine's full core count
# since this same server may be running LibreOffice/OCR jobs at the same
# time, and Node's own MAX_CRACK_JOBS already allows more than one of these
# running at once.
CRACK_MAX_WORKERS = 3


def _crack_try_password(path_and_pw):
    """Module-level (not nested) so multiprocessing can pickle a reference to
    it - a closure or a method wouldn't survive the trip to a worker process."""
    path, pw = path_and_pw
    import pikepdf
    try:
        pdf = pikepdf.open(path, password=pw)
        pdf.close()
        return pw, True
    except pikepdf.PasswordError:
        return pw, False
    except Exception:
        return pw, False  # a handful of malformed-guess edge cases in qpdf; treat as "not this one"


def cmd_pdf_crack(args):
    import time
    import pikepdf
    import multiprocessing

    if not args.input or not os.path.exists(args.input):
        fail("Input PDF not found.")
        return

    # If it opens with no password at all, there's nothing to crack - this is
    # an owner-restriction-only PDF (or not encrypted); point back at Unlock.
    try:
        probe = pikepdf.open(args.input, password="")
        probe.close()
        emit({"ok": True, "found": True, "password": "", "attempts": 0, "elapsedSeconds": 0.0,
              "note": "This PDF has no open password. Use Unlock PDF to remove any owner restrictions."})
        return
    except pikepdf.PasswordError:
        pass  # genuinely needs a password - proceed to search for it
    except Exception as exc:
        fail(f"Could not read PDF: {exc}")
        return

    candidates, total = _crack_candidates(args)
    max_seconds = args.max_seconds or 120
    started_at = time.monotonic()
    last_progress = started_at
    tried = 0
    workers = max(1, min(os.cpu_count() or 1, CRACK_MAX_WORKERS))

    def tasks():
        for pw in candidates:
            yield (args.input, pw)

    with multiprocessing.Pool(processes=workers) as pool:
        for pw, ok in pool.imap_unordered(_crack_try_password, tasks(), chunksize=8):
            tried += 1
            if ok:
                pool.terminate()
                emit({"ok": True, "found": True, "password": pw, "attempts": tried, "total": total,
                      "elapsedSeconds": round(time.monotonic() - started_at, 1)})
                return

            now = time.monotonic()
            if now - last_progress >= CRACK_PROGRESS_INTERVAL_SECONDS:
                emit_progress({"attempts": tried, "total": total, "elapsedSeconds": round(now - started_at, 1)})
                last_progress = now
                if now - started_at > max_seconds:
                    pool.terminate()
                    emit({"ok": True, "found": False, "attempts": tried, "total": total,
                          "elapsedSeconds": round(now - started_at, 1), "reason": "time-limit"})
                    return

    emit({"ok": True, "found": False, "attempts": tried, "total": total,
          "elapsedSeconds": round(time.monotonic() - started_at, 1), "reason": "exhausted"})


# --------------------------------------------------------------------------- #
# Protect (encrypt)
# --------------------------------------------------------------------------- #
def cmd_protect(args):
    import pikepdf
    if not args.password:
        fail("A password is required to protect a PDF.")
        return
    owner = args.owner_password or args.password
    try:
        pdf = pikepdf.open(args.input)
    except pikepdf.PasswordError:
        fail("The source PDF is already encrypted. Unlock it first.")
        return
    perms = pikepdf.Permissions(
        extract=not args.no_copy,
        modify_annotation=not args.no_edit,
        modify_assembly=not args.no_edit,
        modify_form=not args.no_edit,
        modify_other=not args.no_edit,
        print_lowres=True,
        print_highres=not args.no_print,
    )
    enc = pikepdf.Encryption(user=args.password, owner=owner, R=6, aes=True,
                             allow=perms)
    pdf.save(args.output, encryption=enc)
    pdf.close()
    emit({"ok": True, "engine": "pikepdf", "encryption": "AES-256"})


# --------------------------------------------------------------------------- #
# PDF/A-ish archival
# --------------------------------------------------------------------------- #
def cmd_pdfa(args):
    import fitz
    doc = open_pdf(args.input)
    try:
        doc.set_metadata({
            "title": args.title or "Archived document",
            "producer": "Local PDF Studio Engine",
            "creator": "Local PDF Studio",
        })
    except Exception:
        pass
    # Normalize resources with PyMuPDF, then linearize with pikepdf if present.
    doc.save(args.output, garbage=4, clean=True, deflate=True)
    doc.close()
    linearized = False
    try:
        import pikepdf
        pdf = pikepdf.open(args.output, allow_overwriting_input=True)
        pdf.save(args.output, linearize=True, fix_metadata_version=True)
        pdf.close()
        linearized = True
    except Exception:
        pass
    emit({"ok": True, "engine": "pymupdf+pikepdf" if linearized else "pymupdf",
          "linearized": linearized,
          "note": "Archival rebuild (normalized%s). "
                  "Certified PDF/A validation still needs a dedicated validator."
                  % (", linearized" if linearized else "")})


# --------------------------------------------------------------------------- #
# PDF -> images (high quality)
# --------------------------------------------------------------------------- #
def cmd_pdf_to_images(args):
    import fitz
    doc = open_pdf(args.input)
    fmt = (args.img_format or "png").lower()
    dpi = args.dpi or 200
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    stem = args.stem or "page"
    buf = io.BytesIO()
    count = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, page in enumerate(doc):
            pix = page.get_pixmap(matrix=mat, alpha=False)
            if fmt in ("jpg", "jpeg"):
                data = pix.tobytes("jpg", jpg_quality=args.quality or 88)
                ext = "jpg"
            else:
                data = pix.tobytes("png")
                ext = "png"
            zf.writestr(f"{stem}-{i + 1:03d}.{ext}", data)
            count += 1
    doc.close()
    with open(args.output, "wb") as fh:
        fh.write(buf.getvalue())
    emit({"ok": True, "engine": "pymupdf", "pages": count, "dpi": dpi, "format": fmt})


# --------------------------------------------------------------------------- #
# PDF -> Excel
#   1. Ruled/bordered tables  -> PyMuPDF table detection (one sheet per table).
#   2. Spacing-delimited reports (invoices, sales summaries, line-printer output)
#      -> reconstruct columns from vertical whitespace "rivers" so figures land
#      in the right columns as real, sum-able numbers instead of one word/cell.
# --------------------------------------------------------------------------- #
import re as _re

_NUMRE = _re.compile(r"^-?[\d,]+\.?\d*$")
_RULERE = _re.compile(r"^[-=_.\s]+$")
# Column-label keywords. A line is treated as a table header only when it holds
# at least two of these, so section titles like "ITEM WISE SALES SUMMARY" (which
# merely contain the word ITEM) stay intact as a single title cell.
_COLKW = _re.compile(r"\b(QTY|RATE|AMOUNT|FREE|VALUE|DISC|MRP|NET|GST|TAX|"
                     r"BATCH|EXP|DESCRIPTION|DESC|PARTICULARS|PCS|UNIT)\b", _re.I)


def _is_num(token):
    return token == "-" or bool(_NUMRE.match(token.replace("%", "")))


def _num_or_text(token):
    """Turn a numeric-looking string into an int/float so Excel can sum it.

    Percentages are the one case kept as their ORIGINAL TEXT ("18%", not the
    bare number 18): converting "18%" to a plain 18 silently discards the
    percent sign, and a reconstructed invoice cell showing "18" where the
    source said "18%" is not a formatting nicety, it is now WRONG data - a
    rate reads identically to a raw quantity or amount. Confirmed by
    reconstructing a real synthetic invoice and finding the discrepancy.
    """
    s = str(token).strip().replace(",", "")
    if s in ("-", ""):
        return None
    if s.endswith("%"):
        body = s.rstrip("%")
        try:
            float(body)  # validate it's actually numeric before keeping as-is
            return s
        except ValueError:
            return token
    try:
        value = float(s)
        return int(value) if value.is_integer() else value
    except ValueError:
        return token


def _cluster_lines(words, tol=3):
    words = sorted(words, key=lambda w: (w[1], w[0]))
    lines = []
    for w in words:
        for ln in lines:
            if abs(ln["y"] - w[1]) <= tol:
                ln["w"].append(w)
                ln["y"] = (ln["y"] + w[1]) / 2
                break
        else:
            lines.append({"y": w[1], "w": [w]})
    for ln in lines:
        ln["w"].sort(key=lambda w: w[0])
    return sorted(lines, key=lambda l: l["y"])


def _column_bounds(data_lines, width):
    """Column boundaries = vertical whitespace gaps that run through data rows."""
    cover = [0] * width
    for ln in data_lines:
        for w in ln["w"]:
            for x in range(int(w[0]), min(int(w[2]) + 1, width)):
                cover[x] += 1
    xs = [x for x in range(width) if cover[x] > 0]
    if not xs:
        return None
    lo, hi = min(xs), max(xs)
    seps, run = [], None
    for x in range(lo, hi + 1):
        if cover[x] == 0:
            if run is None:
                run = x
        else:
            if run is not None and x - run >= 5:
                seps.append((run + x - 1) // 2)
            run = None
    bounds = [lo - 2] + seps + [hi + 2]
    return bounds if len(bounds) > 2 else None


def _split_into_columns(ln, bounds):
    cells = [""] * (len(bounds) - 1)
    for w in ln["w"]:
        cx = (w[0] + w[2]) / 2
        ci = len(cells) - 1
        for i in range(len(bounds) - 1):
            if bounds[i] <= cx < bounds[i + 1]:
                ci = i
                break
        cells[ci] = (cells[ci] + " " + w[4]).strip()
    return cells


def _reconstruct_report(doc):
    """Reconstruct a spacing-delimited report into structured rows.

    Returns (rows, ncols, ndata) where each row is a dict:
      {"kind": "title", "text": str}         - a title/address/note line
      {"kind": "row",   "cells": [str, ...]} - a table row (numbers kept typed)
    ndata is how many multi-column data rows were found (used to decide whether
    a document really is a columnar report).
    """
    rows = []
    ncols = 1
    ndata = 0
    seen_titles = set()
    for pno, page in enumerate(doc):
        lines = _cluster_lines(page.get_text("words"))
        data = [ln for ln in lines if sum(_is_num(w[4]) for w in ln["w"]) >= 2]
        bounds = _column_bounds(data, int(page.rect.width) + 2)
        for ln in lines:
            text = " ".join(w[4] for w in ln["w"])
            if not text.strip() or _RULERE.match(text):
                continue
            n_num = sum(_is_num(w[4]) for w in ln["w"])
            # The word-count floor guards against a coincidental short phrase
            # that happens to contain one keyword; it must not be stricter
            # than what a real short header can legitimately be. >=2 distinct
            # keyword matches already requires at least 2 keyword-bearing
            # words, so a 3-word header ("Product Qty Amount") is completely
            # normal and must pass - confirmed by reconstructing one: the
            # old `> 3` threshold silently dropped it into a single merged
            # title cell instead of a proper header row.
            is_header = (len({m.upper() for m in _COLKW.findall(text)}) >= 2
                         and n_num == 0 and len(ln["w"]) >= 2)
            if bounds and (n_num >= 2 or is_header):
                cells = [_num_or_text(c) if _is_num(c) else c
                         for c in _split_into_columns(ln, bounds)]
                while len(cells) > 1 and cells[-1] in (None, ""):
                    cells.pop()
                rows.append({"kind": "row", "cells": cells})
                ncols = max(ncols, len(cells))
                if n_num >= 2:
                    ndata += 1
            else:
                if pno > 0 and text in seen_titles:
                    continue
                seen_titles.add(text)
                rows.append({"kind": "title", "text": text})
    return rows, ncols, ndata


def _report_to_sheet(doc, ws):
    from openpyxl.utils import get_column_letter
    rows, ncols, _ndata = _reconstruct_report(doc)
    for r, item in enumerate(rows, start=1):
        if item["kind"] == "title":
            ws.cell(row=r, column=1, value=item["text"])
        else:
            for c, value in enumerate(item["cells"], start=1):
                if value not in (None, ""):
                    ws.cell(row=r, column=c, value=value)
    ws.column_dimensions["A"].width = 34
    for c in range(2, ncols + 1):
        ws.column_dimensions[get_column_letter(c)].width = 11
    return len(rows), ncols


def _report_to_docx(doc, document):
    """Build a Word doc: title lines as paragraphs, tabular runs as real tables."""
    from docx.shared import Pt, Inches
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.section import WD_ORIENT
    rows, ncols, ndata = _reconstruct_report(doc)
    # Wide reports read best in landscape - room for long names AND every column.
    if ncols >= 4:
        section = document.sections[0]
        if section.page_width < section.page_height:
            section.orientation = WD_ORIENT.LANDSCAPE
            section.page_width, section.page_height = section.page_height, section.page_width
        section.left_margin = section.right_margin = Inches(0.6)
    usable = 9.5 if ncols >= 4 else 6.5
    # Fixed column widths so every block's table lines up down the page.
    first_w = 2.7
    rest_w = max(0.7, min(1.15, (usable - first_w) / max(1, ncols - 1)))
    widths = [Inches(first_w)] + [Inches(rest_w)] * (ncols - 1)
    pending = []  # buffered consecutive "row" items -> one table

    def flush():
        if not pending:
            return
        table = document.add_table(rows=len(pending), cols=ncols)
        table.style = "Table Grid"
        table.autofit = False
        table.allow_autofit = False
        for ri, cells in enumerate(pending):
            for ci in range(ncols):
                val = cells[ci] if ci < len(cells) else ""
                cell = table.rows[ri].cells[ci]
                cell.width = widths[ci]
                cell.text = "" if val in (None, "") else str(val)
                if ci > 0:  # right-align numeric columns
                    for p in cell.paragraphs:
                        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        document.add_paragraph()
        pending.clear()

    first_title = True
    for item in rows:
        if item["kind"] == "row":
            pending.append(item["cells"])
        else:
            flush()
            para = document.add_paragraph(item["text"])
            if first_title and para.runs:
                para.runs[0].font.bold = True
                para.runs[0].font.size = Pt(13)
            first_title = False
    flush()
    return len(rows), ndata


def cmd_pdf_to_excel(args):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment

    doc = open_pdf(args.input)
    wb = Workbook()
    wb.remove(wb.active)
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="2563EB")
    tables_found = 0

    # 1) Ruled/bordered tables.
    for pno, page in enumerate(doc):
        try:
            page_tables = list(page.find_tables().tables)
        except Exception:
            page_tables = []
        for tno, table in enumerate(page_tables):
            rows = table.extract()
            if not rows or len(rows) < 2:
                continue
            title = f"P{pno + 1}" + (f"-T{tno + 1}" if len(page_tables) > 1 else "")
            ws = wb.create_sheet(title[:31])
            for r, row in enumerate(rows):
                for c, val in enumerate(row):
                    cell = ws.cell(row=r + 1, column=c + 1,
                                   value=("" if val is None else _num_or_text(val)))
                    if r == 0:
                        cell.font = header_font
                        cell.fill = header_fill
                        cell.alignment = Alignment(vertical="center")
            for col in ws.columns:
                width = max((len(str(c.value)) for c in col if c.value), default=10)
                ws.column_dimensions[col[0].column_letter].width = min(60, max(10, width + 2))
            tables_found += 1

    mode = "tables"
    rows_written = 0
    # 2) No ruled tables -> reconstruct the report into one continuous sheet.
    if tables_found == 0:
        ws = wb.create_sheet("Report")
        rows_written, _cols = _report_to_sheet(doc, ws)
        if rows_written:
            ws["A1"].font = Font(bold=True, size=12)
        mode = "report"

    if not wb.sheetnames or (mode == "report" and rows_written == 0):
        if "Report" in wb.sheetnames:
            wb.remove(wb["Report"])
        ws = wb.create_sheet("PDF")
        ws["A1"] = "No selectable text or tables were found."
        ws["A2"] = "If this is a scanned PDF, run OCR first."
        mode = "empty"

    wb.save(args.output)
    pages = doc.page_count
    doc.close()
    emit({"ok": True, "engine": "pymupdf+openpyxl",
          "mode": mode, "tables": tables_found, "rows": rows_written, "pages": pages})


# --------------------------------------------------------------------------- #
# PDF -> Word
# --------------------------------------------------------------------------- #
def cmd_pdf_to_word(args):
    from docx import Document

    # Spacing-delimited reports (invoices, sales summaries) come out of pdf2docx
    # as ragged proportional-font text. Detect them and build real Word tables
    # instead, so columns line up and stay editable.
    doc = open_pdf(args.input)
    has_ruled = False
    try:
        for page in doc:
            if list(page.find_tables().tables):
                has_ruled = True
                break
    except Exception:
        has_ruled = False
    report_rows = report_ndata = 0
    if not has_ruled:
        _rows, _cols, report_ndata = _reconstruct_report(doc)
        report_rows = len(_rows)

    if not has_ruled and report_ndata >= 5:
        out = Document()
        rows_written, ndata = _report_to_docx(doc, out)
        out.save(args.output)
        pages = doc.page_count
        doc.close()
        emit({"ok": True, "engine": "pymupdf+python-docx", "fidelity": "report",
              "rows": rows_written, "dataRows": ndata, "pages": pages})
        return
    doc.close()

    # Normal documents: pdf2docx keeps layout, real tables, and images.
    try:
        from pdf2docx import Converter
        cv = Converter(args.input)
        cv.convert(args.output, start=0, end=None)
        cv.close()
        emit({"ok": True, "engine": "pdf2docx", "fidelity": "layout"})
        return
    except Exception as exc:
        note = f"pdf2docx unavailable ({exc}); used text extraction"

    # Last-resort fallback: python-docx from PyMuPDF text blocks.
    doc = open_pdf(args.input)
    out = Document()
    for pno, page in enumerate(doc):
        blocks = page.get_text("blocks")
        blocks.sort(key=lambda b: (b[1], b[0]))
        for b in blocks:
            text = (b[4] or "").strip()
            if text:
                out.add_paragraph(text)
        if pno != doc.page_count - 1:
            out.add_page_break()
    out.save(args.output)
    doc.close()
    emit({"ok": True, "engine": "python-docx", "fidelity": "text", "note": note})


# --------------------------------------------------------------------------- #
# PDF -> PowerPoint (one slide per page image)
# --------------------------------------------------------------------------- #
def cmd_pdf_to_ppt(args):
    import fitz
    from pptx import Presentation
    from pptx.util import Emu

    doc = open_pdf(args.input)
    prs = Presentation()
    # Size the deck to the first page aspect ratio.
    first = doc[0].rect
    prs.slide_width = Emu(int(first.width / 72.0 * 914400))
    prs.slide_height = Emu(int(first.height / 72.0 * 914400))
    blank = prs.slide_layouts[6]
    zoom = (args.dpi or 150) / 72.0
    mat = fitz.Matrix(zoom, zoom)
    for page in doc:
        pix = page.get_pixmap(matrix=mat, alpha=False)
        data = pix.tobytes("png")
        slide = prs.slides.add_slide(blank)
        sw = Emu(int(page.rect.width / 72.0 * 914400))
        sh = Emu(int(page.rect.height / 72.0 * 914400))
        slide.shapes.add_picture(io.BytesIO(data), 0, 0, width=sw, height=sh)
    slides = doc.page_count
    prs.save(args.output)
    doc.close()
    emit({"ok": True, "engine": "pymupdf+python-pptx", "slides": slides})


# --------------------------------------------------------------------------- #
# Watermark removal - the flagship, multi-strategy and mostly lossless
# --------------------------------------------------------------------------- #
def _norm_wm_text(s):
    return " ".join((s or "").split()).strip().lower()


def _wm_repeated_strings(doc, targets):
    """The single strongest watermark signal, which the old heuristic ignored:
    the SAME short string stamped on many pages. Returns a set of normalized
    strings that appear on >= max(2, 50% of) the scanned pages and are short
    enough to be a mark (not body text)."""
    from collections import defaultdict
    pages_with = defaultdict(set)
    for i in targets:
        try:
            d = doc[i].get_text("dict")
        except Exception:
            continue
        for block in d.get("blocks", []):
            for line in block.get("lines", []):
                txt = _norm_wm_text("".join(sp.get("text", "")
                                            for sp in line.get("spans", [])))
                # Marks are short phrases: <= 5 words, <= 40 chars, non-empty.
                if txt and len(txt) <= 40 and len(txt.split()) <= 5:
                    pages_with[txt].add(i)
    n = max(1, len(targets))
    threshold = max(2, int(round(n * 0.5)))
    return {t for t, pgs in pages_with.items() if len(pgs) >= threshold}


def _watermark_score(span, line, page_rect, repeated):
    """Composite 0..1 score with a hard TRIGGER gate.

    The decisive lesson from testing: repetition and large size are NOT
    watermark triggers on their own - running titles, page headers, and section
    headings are all large and/or repeated. What actually marks a watermark is
    that it is *faint* (a light overlay meant to sit under content) or *rotated*
    (a diagonal stamp). Dark, horizontal, upright text is content, no matter how
    big or how often it repeats. So we GATE on {faint-and-sizable, rotated};
    size and repetition only amplify a candidate that already passed the gate.
    """
    text = _norm_wm_text(span.get("text", ""))
    if not text:
        return 0.0
    size = span.get("size", 0)
    color = span.get("color", 0)
    r = (color >> 16) & 255
    g = (color >> 8) & 255
    b = color & 255

    dirn = line.get("dir", (1, 0))
    rotated = abs(dirn[1]) > 0.15                       # tilted > ~8.6 deg
    is_light = min(r, g, b) > 150 and (max(r, g, b) - min(r, g, b)) < 45
    faint = is_light and size >= 16                     # a light *and sizable* mark
    large = size >= 24
    is_repeated = text in repeated
    short = len(text) <= 40 and len(text.split()) <= 5

    # TRIGGER gate: nothing that is neither faint-sizable nor rotated can be a
    # watermark. This keeps dark headings, running titles, and small grey
    # captions safe.
    if not (faint or rotated):
        return 0.0

    score = 0.0
    score += 0.50 if rotated else 0.0
    score += 0.50 if faint else 0.0
    score += 0.15 if large else 0.0
    score += 0.25 if is_repeated else 0.0
    score += 0.05 if short else 0.0
    return min(score, 1.0)


# Backwards-compatible shim (kept so nothing else that imports it breaks).
def _looks_like_watermark_text(span, page_rect):
    return _watermark_score(span, {"dir": (1, 0)}, page_rect, set()) >= 0.45


def cmd_remove_watermark(args):
    import fitz

    doc = open_pdf(args.input)
    report = {
        "layersRemoved": 0,
        "annotsRemoved": 0,
        "imagesRemoved": 0,
        "textInstancesRemoved": 0,
        "regionsRedacted": 0,
    }
    mode = args.mode or "auto"
    targets = page_indices(doc, args.pages, args.page)

    # ---- 1. Optional-content (layer) watermarks: fully lossless ----------- #
    if mode in ("auto", "layers"):
        try:
            ocgs = doc.get_ocgs() or {}
            wm_xrefs = []
            for xref, info in ocgs.items():
                name = (info.get("name") or "").lower()
                if any(k in name for k in ("watermark", "stamp", "sample",
                                           "confidential", "draft", "copy",
                                           "background", "logo")):
                    wm_xrefs.append(xref)
            # If the caller forces layer mode with no name match, drop them all.
            if mode == "layers" and not wm_xrefs and ocgs:
                wm_xrefs = list(ocgs.keys())
            for xref in wm_xrefs:
                try:
                    # Hide by default and remove the layer's marked content.
                    doc.set_layer(-1, off=[xref])
                    report["layersRemoved"] += 1
                except Exception:
                    pass
        except Exception:
            pass

    # ---- 2. Watermark / stamp annotations -------------------------------- #
    if mode in ("auto", "annots"):
        for i in targets:
            page = doc[i]
            try:
                annot = page.first_annot
                while annot:
                    nxt = annot.next
                    atype = annot.type[1].lower() if annot.type else ""
                    if atype in ("watermark", "stamp", "freetext"):
                        page.delete_annot(annot)
                        report["annotsRemoved"] += 1
                    annot = nxt
            except Exception:
                pass

    # ---- 3. Repeated / transparent image watermarks ---------------------- #
    if mode in ("auto", "images"):
        # Count how often each image xref appears across pages.
        occ = {}
        for i in range(doc.page_count):
            for info in doc[i].get_images(full=True):
                occ[info[0]] = occ.get(info[0], 0) + 1
        threshold = max(2, int(doc.page_count * 0.5))
        repeated = {x for x, c in occ.items() if c >= threshold}
        for i in targets:
            page = doc[i]
            for info in page.get_images(full=True):
                xref = info[0]
                smask = info[1]
                remove = xref in repeated or (smask and mode == "images")
                if remove:
                    try:
                        page.delete_image(xref)
                        report["imagesRemoved"] += 1
                    except Exception:
                        pass

    # ---- 4. Known text watermark: redact just those glyphs --------------- #
    if mode in ("auto", "text") and args.text:
        for i in targets:
            page = doc[i]
            try:
                rects = page.search_for(args.text, quads=False)
                for r in rects:
                    page.add_redact_annot(r, fill=None)
                    report["textInstancesRemoved"] += 1
                if rects:
                    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
            except Exception:
                pass

    # ---- 4b. Auto text watermark detection (no text supplied) ------------ #
    if mode == "auto" and not args.text:
        # Pre-pass across all target pages for the repetition signal.
        repeated = _wm_repeated_strings(doc, targets)
        WM_THRESHOLD = 0.45
        report.setdefault("textCandidates", [])
        for i in targets:
            page = doc[i]
            try:
                d = page.get_text("dict")
                to_redact = []
                for block in d.get("blocks", []):
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            sc = _watermark_score(span, line, page.rect, repeated)
                            if sc >= WM_THRESHOLD:
                                to_redact.append(fitz.Rect(span["bbox"]))
                                if len(report["textCandidates"]) < 50:
                                    report["textCandidates"].append({
                                        "page": i,
                                        "text": span.get("text", "")[:60],
                                        "score": round(sc, 2),
                                    })
                for r in to_redact:
                    page.add_redact_annot(r, fill=None)
                if to_redact:
                    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
                    report["textInstancesRemoved"] += len(to_redact)
            except Exception:
                pass

    # ---- 5. Explicit region redaction (user drew a box) ------------------ #
    if mode == "region" and args.rect:
        for i in targets:
            page = doc[i]
            try:
                r = rect_from_fraction(page, args.rect)
                page.add_redact_annot(r, fill=None)
                page.apply_redactions()
                report["regionsRedacted"] += 1
            except Exception:
                pass

    doc.save(args.output, garbage=4, clean=True, deflate=True)
    doc.close()
    total = sum(v for v in report.values() if isinstance(v, int))
    emit({"ok": True, "engine": "pymupdf", "mode": mode, "removed": total, **report})


# --------------------------------------------------------------------------- #
# True region redaction: strips the text/images/vector art under each box
# (not a painted-over rectangle - the editor's client-side "Redact"/"Eraser"
# tools used to only draw a rectangle on top, leaving the original content
# fully intact and extractable underneath. This actually removes it.)
# Each region may carry its own "fill" ("black", the default, for Redact;
# "white" for Eraser) so both tools share this one removal pass.
# --------------------------------------------------------------------------- #
def cmd_redact_regions(args):
    import fitz
    doc = open_pdf(args.input)
    regions = json.loads(args.regions_json)
    by_page = {}
    for r in regions:
        by_page.setdefault(int(r["page"]), []).append(r)
    count = 0
    for pno, region_list in by_page.items():
        if pno < 0 or pno >= doc.page_count:
            continue
        page = doc[pno]
        for r in region_list:
            rect = rect_from_fraction(page, r["rect"])
            fill = (1, 1, 1) if r.get("fill") == "white" else (0, 0, 0)
            page.add_redact_annot(rect, fill=fill)
            count += 1
        page.apply_redactions(
            images=fitz.PDF_REDACT_IMAGE_REMOVE,
            text=fitz.PDF_REDACT_TEXT_REMOVE,
            graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,
        )
    doc.save(args.output, garbage=4, clean=True, deflate=True)
    doc.close()
    emit({"ok": True, "engine": "pymupdf", "regionsRedacted": count})


# --------------------------------------------------------------------------- #
# Document intelligence: real extractive summarization (TextRank) + keyword
# and entity extraction, entirely local - no AI API key needed. See
# engine/nlp/summarize.py for why this exists: "AI Summarizer" previously
# required the user to already have their own paid API key, which defeats
# the point of a free tool.
# --------------------------------------------------------------------------- #
def cmd_summarize(args):
    import sys as _sys
    _sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine"))
    from nlp import summarize as nlp_summarize

    doc = open_pdf(args.input)
    pages = page_indices(doc, args.pages, args.page)
    text = "\n".join(doc[i].get_text("text") for i in pages)
    doc.close()
    if not text.strip():
        emit({"ok": True, "engine": "textrank", "empty": True,
              "summary": "", "sentences": [], "keywords": [], "entities": {}, "readability": {}})
        return
    target = args.sentences or 6
    result = nlp_summarize.analyze_document(text, max_sentences=target)
    emit({"ok": True, "engine": "textrank", "empty": False, **result})


# --------------------------------------------------------------------------- #
# Real PDF comparison: page-level alignment (so inserted/deleted/reordered
# pages are identified, not just zipped 1:1), then a word-level diff within
# each matched page pair, with real bounding boxes for every added/removed
# word. The old browser-only comparer just set-subtracted the bag of words in
# each document - no order, no position, no idea whether a change was one
# edited sentence or the whole page. This is an actual diff.
# --------------------------------------------------------------------------- #
def _page_words(page):
    """[(x0,y0,x1,y1,word), ...] in reading order."""
    words = page.get_text("words")
    words.sort(key=lambda w: (round(w[1], 1), w[0]))
    return [(w[0], w[1], w[2], w[3], w[4]) for w in words]


def _diff_page_words(pageA, pageB):
    import difflib
    wa = _page_words(pageA)
    wb = _page_words(pageB)
    ta = [w[4] for w in wa]
    tb = [w[4] for w in wb]
    sm = difflib.SequenceMatcher(None, ta, tb, autojunk=False)
    removed, added = [], []
    equal_count = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            equal_count += i2 - i1
            continue
        if tag in ("delete", "replace"):
            for w in wa[i1:i2]:
                removed.append({"text": w[4], "bbox": [round(w[0], 1), round(w[1], 1), round(w[2], 1), round(w[3], 1)]})
        if tag in ("insert", "replace"):
            for w in wb[j1:j2]:
                added.append({"text": w[4], "bbox": [round(w[0], 1), round(w[1], 1), round(w[2], 1), round(w[3], 1)]})
    total = max(len(ta), len(tb), 1)
    similarity = equal_count / total
    return removed, added, similarity


def cmd_compare(args):
    import fitz
    import difflib

    docA = open_pdf(args.input)
    docB = open_pdf(args.input2)
    textsA = [p.get_text("text") for p in docA]
    textsB = [p.get_text("text") for p in docB]

    # Page-level alignment: treat each page's full text as one "symbol" in an
    # outer diff over the two documents' page sequences. This correctly finds
    # inserted/deleted pages instead of assuming page N in A corresponds to
    # page N in B (which breaks the moment a page is added or removed).
    sm = difflib.SequenceMatcher(None, textsA, textsB, autojunk=False)
    page_changes = []
    unchanged_pages = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            unchanged_pages += i2 - i1
            continue
        pairs = list(zip(range(i1, i2), range(j1, j2)))
        for ai, bi in pairs:
            removed, added, similarity = _diff_page_words(docA[ai], docB[bi])
            if not removed and not added:
                unchanged_pages += 1
                continue
            page_changes.append({
                "pageA": ai + 1, "pageB": bi + 1, "type": "modified",
                "similarity": round(similarity, 3), "removed": removed, "added": added,
            })
        for ai in range(i1 + len(pairs), i2):
            page_changes.append({"pageA": ai + 1, "pageB": None, "type": "deleted"})
        for bi in range(j1 + len(pairs), j2):
            page_changes.append({"pageA": None, "pageB": bi + 1, "type": "inserted"})

    # Visual diff PDF: every changed page appears twice in sequence - the
    # ORIGINAL page from A with removed words boxed in red, then the page
    # from B with added words boxed in green - stamped so it is obvious which
    # is which without needing a legend. Unchanged pages are skipped so a
    # 40-page contract with one edited clause produces a short, useful
    # document instead of forcing a page-by-page hunt.
    out = fitz.open()
    RED = (0.86, 0.15, 0.15)
    GREEN = (0.10, 0.55, 0.20)

    def stamp(page, label, color):
        r = page.rect
        page.draw_rect(fitz.Rect(0, 0, r.width, 22), color=color, fill=color, overlay=True)
        page.insert_text((8, 15), label, fontsize=11, color=(1, 1, 1), overlay=True)

    def box_words(page, items, color):
        for item in items:
            x0, y0, x1, y1 = item["bbox"]
            page.draw_rect(fitz.Rect(x0 - 1.5, y0 - 1.5, x1 + 1.5, y1 + 1.5), color=color, width=1.3, overlay=True)

    for change in page_changes:
        if change["type"] == "modified":
            pa = out.new_page(width=docA[change["pageA"] - 1].rect.width, height=docA[change["pageA"] - 1].rect.height)
            pa.show_pdf_page(pa.rect, docA, change["pageA"] - 1)
            box_words(pa, change["removed"], RED)
            stamp(pa, f"BEFORE - page {change['pageA']} - {len(change['removed'])} word(s) removed/changed", RED)
            pb = out.new_page(width=docB[change["pageB"] - 1].rect.width, height=docB[change["pageB"] - 1].rect.height)
            pb.show_pdf_page(pb.rect, docB, change["pageB"] - 1)
            box_words(pb, change["added"], GREEN)
            stamp(pb, f"AFTER - page {change['pageB']} - {len(change['added'])} word(s) added/changed", GREEN)
        elif change["type"] == "deleted":
            src = docA[change["pageA"] - 1]
            pa = out.new_page(width=src.rect.width, height=src.rect.height)
            pa.show_pdf_page(pa.rect, docA, change["pageA"] - 1)
            stamp(pa, f"REMOVED - page {change['pageA']} does not appear in the new document", RED)
        elif change["type"] == "inserted":
            src = docB[change["pageB"] - 1]
            pb = out.new_page(width=src.rect.width, height=src.rect.height)
            pb.show_pdf_page(pb.rect, docB, change["pageB"] - 1)
            stamp(pb, f"NEW - page {change['pageB']} does not appear in the original document", GREEN)

    words_removed = sum(len(c.get("removed", [])) for c in page_changes)
    words_added = sum(len(c.get("added", [])) for c in page_changes)
    pages_modified = sum(1 for c in page_changes if c["type"] == "modified")
    pages_deleted = sum(1 for c in page_changes if c["type"] == "deleted")
    pages_inserted = sum(1 for c in page_changes if c["type"] == "inserted")
    identical = not page_changes

    if identical:
        # Nothing to show - still produce a valid, honest one-page result
        # rather than an empty/broken PDF.
        p = out.new_page(width=595, height=200)
        p.insert_text((40, 100), "These documents are textually identical.", fontsize=14)

    out.save(args.output, garbage=4, deflate=True)
    out.close()
    docA.close()
    docB.close()
    emit({
        "ok": True, "engine": "pymupdf+difflib",
        "pagesA": len(textsA), "pagesB": len(textsB),
        "pagesUnchanged": unchanged_pages, "pagesModified": pages_modified,
        "pagesDeleted": pages_deleted, "pagesInserted": pages_inserted,
        "wordsRemoved": words_removed, "wordsAdded": words_added,
        "identical": identical,
    })


# --------------------------------------------------------------------------- #
# Rasterize a single page for the browser preview after structural edits.
# --------------------------------------------------------------------------- #
def cmd_page_png(args):
    import fitz
    doc = open_pdf(args.input)
    page = doc[(args.page or 1) - 1]
    zoom = (args.dpi or 150) / 72.0
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    pix.save(args.output)
    doc.close()
    emit({"ok": True, "engine": "pymupdf"})


# --------------------------------------------------------------------------- #
# OCR
#   The browser ran tesseract.js against the viewer canvas (screen-resolution,
#   un-deskewed, with CDN-downloaded language data). These commands run the
#   real engine against the PDF itself - see engine/ocr/ocr_engine.py for why
#   that distinction is the whole difference between "OCR does nothing" and
#   usable text.
# --------------------------------------------------------------------------- #
def _load_ocr():
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine"))
    from ocr import ocr_engine
    return ocr_engine


# Recognition quality stops improving once glyphs are comfortably above the
# recogniser's input height, and both engines downscale internally past this,
# so rendering bigger only costs time. ~2200px on the long edge is about
# 190 DPI on A4 - the knee of the curve for PP-OCRv4.
_OCR_TARGET_LONG_SIDE = 2200


def _auto_dpi(page, requested=None):
    if requested:
        return max(72, min(int(requested), 600))
    long_side_pt = max(page.rect.width, page.rect.height) or 612.0
    dpi = _OCR_TARGET_LONG_SIDE / (long_side_pt / 72.0)
    return int(max(110, min(dpi, 400)))


def _page_image(page, dpi):
    """Rendered page as a BGR numpy array (what OpenCV and the recogniser want)."""
    import fitz
    import numpy as np
    import cv2
    zoom = dpi / 72.0
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    if pix.n == 4:
        return cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR)
    if pix.n == 1:
        return cv2.cvtColor(arr, cv2.COLOR_GRAY2BGR)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


def _text_layer_words(page, dpi):
    """Existing PDF text, in the same word shape the OCR path returns.

    A page that already carries a text layer needs no recognition at all: its
    text is exact, where OCR is a guess. Reporting it in the identical shape
    means the editor runs one code path either way.
    """
    scale = dpi / 72.0
    words = []
    for x0, y0, x1, y1, word, _block, _line, _wno in page.get_text("words"):
        text = (word or "").strip()
        if not text:
            continue
        words.append({
            "text": text,
            "confidence": 100.0,
            "bbox": {"x0": x0 * scale, "y0": y0 * scale, "x1": x1 * scale, "y1": y1 * scale},
        })
    return words


def _group_words_into_lines(words, tolerance=6.0):
    lines = []
    for word in sorted(words, key=lambda w: (w["bbox"]["y0"], w["bbox"]["x0"])):
        placed = False
        for line in lines:
            if abs(line["bbox"]["y0"] - word["bbox"]["y0"]) <= tolerance:
                line["words"].append(word)
                b, wb = line["bbox"], word["bbox"]
                b["x0"] = min(b["x0"], wb["x0"]); b["y0"] = min(b["y0"], wb["y0"])
                b["x1"] = max(b["x1"], wb["x1"]); b["y1"] = max(b["y1"], wb["y1"])
                placed = True
                break
        if not placed:
            lines.append({"words": [word], "bbox": dict(word["bbox"]), "confidence": 100.0})
    for line in lines:
        line["words"].sort(key=lambda w: w["bbox"]["x0"])
        line["text"] = " ".join(w["text"] for w in line["words"])
        b = line["bbox"]
        line["quad"] = [[b["x0"], b["y0"]], [b["x1"], b["y0"]], [b["x1"], b["y1"]], [b["x0"], b["y1"]]]
    return lines


def _emit_ocr(args, result, page, dpi):
    """Full word geometry goes to --output as JSON; stdout keeps the summary.

    A dense page is thousands of boxes - far too much to push through the
    one-line stdout status channel every other command uses.
    """
    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False)
    emit({
        "ok": True,
        "engine": result.get("engine"),
        "backend": result.get("backend"),
        "page": page,
        "dpi": dpi,
        "width": result.get("width"),
        "height": result.get("height"),
        "skewAngle": result.get("skewAngle", 0.0),
        "lines": len(result.get("lines", [])),
        "words": len(result.get("words", [])),
        "meanConfidence": result.get("meanConfidence", 0.0),
        "chars": len(result.get("text", "")),
    })


def cmd_ocr(args):
    """OCR one PDF page (or a standalone image) -> word boxes as JSON."""
    ocr_engine = _load_ocr()
    import cv2
    lang = args.lang or "eng"
    backend = args.backend or "auto"

    is_pdf = (args.input or "").lower().endswith(".pdf")
    page_number = args.page or 1

    if is_pdf:
        doc = open_pdf(args.input)
        if doc.page_count == 0:
            fail("The PDF has no pages.")
        index = max(0, min(page_number - 1, doc.page_count - 1))
        page = doc[index]
        dpi = _auto_dpi(page, args.dpi)
        existing = [] if args.force_ocr else _text_layer_words(page, dpi)
        if len(" ".join(w["text"] for w in existing)) >= 40:
            lines = _group_words_into_lines(existing)
            result = {
                "ok": True,
                "engine": "PDF text layer",
                "backend": "text-layer",
                "language": lang,
                "width": int(page.rect.width * dpi / 72.0),
                "height": int(page.rect.height * dpi / 72.0),
                "skewAngle": 0.0,
                "lines": lines,
                "words": existing,
                "text": "\n".join(line["text"] for line in lines),
                "meanConfidence": 100.0,
                "page": page_number,
                "pages": doc.page_count,
                "dpi": dpi,
            }
            doc.close()
            _emit_ocr(args, result, page=page_number, dpi=dpi)
            return
        image = _page_image(page, dpi)
        source = {"page": page_number, "pages": doc.page_count, "dpi": dpi}
        doc.close()
    else:
        image = cv2.imread(args.input, cv2.IMREAD_COLOR)
        if image is None:
            fail("Could not read image: %s" % args.input)
        source = {"page": 1, "pages": 1, "dpi": args.dpi or 0}

    result = ocr_engine.recognize(
        image,
        lang=lang,
        backend=backend,
        deskew=not args.no_deskew,
        enhance=not args.no_enhance,
        min_confidence=float(args.min_confidence if args.min_confidence is not None else 30),
    )
    if not result.get("ok"):
        # A language this server cannot handle is not a crash: the browser
        # engine can still fetch that traineddata, so report it precisely and
        # let the front-end fall back instead of showing a dead end.
        emit({
            "ok": False,
            "error": result.get("error", "OCR failed"),
            "unsupportedLanguage": bool(result.get("unsupportedLanguage")),
            "languages": result.get("languages", []),
        }, code=1)
        return
    result.update(source)
    _emit_ocr(args, result, page=source["page"], dpi=source["dpi"])


def _insert_invisible_text(page, words, dpi):
    """Write recognised words onto the page as invisible, selectable text.

    Render mode 3 (neither fill nor stroke) is the standard searchable-scan
    construction: the scan still shows exactly as before, but Ctrl+F, copy,
    and every downstream text extractor now work on the page.
    """
    import fitz
    scale = 72.0 / dpi
    written = 0
    font = fitz.Font("helv")
    writer = fitz.TextWriter(page.rect)
    for word in words:
        text = word["text"].strip()
        if not text:
            continue
        box = word["bbox"]
        x0, y1 = box["x0"] * scale, box["y1"] * scale
        height = max(1.0, (box["y1"] - box["y0"]) * scale)
        width = max(1.0, (box["x1"] - box["x0"]) * scale)
        try:
            unit_length = font.text_length(text, fontsize=1)
        except Exception:
            continue
        if unit_length <= 0:
            continue
        # Fit the box in BOTH axes: height keeps the invisible line sitting on
        # the visible one, width stops a long word from overhanging into the
        # next column, which would make selection rectangles wrong.
        size = max(1.0, min(height * 0.85, width / unit_length))
        try:
            writer.append(fitz.Point(x0, y1 - height * 0.18), text, font=font, fontsize=size)
            written += 1
        except Exception:
            continue
    if written:
        writer.write_text(page, render_mode=3)
    return written


def cmd_ocr_pdf(args):
    """Whole document -> the same PDF with a real, searchable text layer."""
    ocr_engine = _load_ocr()
    lang = args.lang or "eng"
    backend = args.backend or "auto"
    if ocr_engine.pick_backend(lang, backend) is None:
        emit({
            "ok": False,
            "error": "No installed OCR engine covers language '%s'." % lang,
            "unsupportedLanguage": ocr_engine.ocr_available(),
            "languages": ocr_engine.capabilities()["languages"],
        }, code=1)
        return

    doc = open_pdf(args.input)
    pages_done = 0
    pages_skipped = 0
    total_words = 0
    confidences = []
    engine_name = None
    for index in page_indices(doc, args.pages, args.page):
        page = doc[index]
        if not args.force_ocr and len(page.get_text().strip()) >= 40:
            # Already searchable. Re-OCRing would stack a guessed layer on top
            # of correct text and corrupt every future extraction.
            pages_skipped += 1
            continue
        dpi = _auto_dpi(page, args.dpi)
        result = ocr_engine.recognize(
            _page_image(page, dpi),
            lang=lang, backend=backend,
            deskew=not args.no_deskew, enhance=not args.no_enhance,
            min_confidence=float(args.min_confidence if args.min_confidence is not None else 40),
        )
        if not result.get("ok"):
            doc.close()
            fail(result.get("error", "OCR failed"))
            return
        engine_name = result.get("engine")
        words = result.get("words", [])
        total_words += _insert_invisible_text(page, words, dpi)
        confidences.extend(w["confidence"] for w in words)
        pages_done += 1

    doc.save(args.output, garbage=3, deflate=True)
    doc.close()
    emit({
        "ok": True,
        "engine": engine_name or "none",
        "pagesOcred": pages_done,
        "pagesSkipped": pages_skipped,
        "words": total_words,
        "meanConfidence": round(sum(confidences) / len(confidences), 1) if confidences else 0.0,
        "searchable": total_words > 0,
    })


# --------------------------------------------------------------------------- #
# Organize: merge / split / extract / rotate / delete / reorder
#   Server-side versions of the browser pdf-lib tools, so large or many-page
#   documents don't have to be loaded into the browser tab. All page numbers in
#   the API are 1-based (what a user sees); internally we work 0-based.
# --------------------------------------------------------------------------- #
def parse_page_spec(spec, n):
    """'1-3,5,7-' over an n-page doc -> sorted unique 0-based indices.
    'all'/'' -> every page. Open-ended 'a-' means a..end. Out-of-range parts are
    clamped/ignored rather than crashing (defensive against bad UI input)."""
    spec = (spec or "all").strip().lower()
    if spec in ("all", "*", ""):
        return list(range(n))
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            try:
                start = int(a) if a.strip() else 1
                end = int(b) if b.strip() else n
            except ValueError:
                continue
            if start > end:
                start, end = end, start
            for p in range(start, end + 1):
                if 1 <= p <= n:
                    out.append(p - 1)
        else:
            try:
                p = int(part)
            except ValueError:
                continue
            if 1 <= p <= n:
                out.append(p - 1)
    # de-dup, preserve order of first appearance
    seen = set(); res = []
    for i in out:
        if i not in seen:
            seen.add(i); res.append(i)
    return res


def _inputs_list(args):
    """Merge inputs come as a JSON array in --inputs-json, else fall back to
    --input + --input2 for the simple two-file case."""
    if getattr(args, "inputs_json", None):
        try:
            arr = json.loads(args.inputs_json)
            if isinstance(arr, list) and arr:
                return [str(x) for x in arr]
        except Exception:
            pass
    both = [p for p in (args.input, args.input2) if p]
    return both


def cmd_merge(args):
    import fitz
    inputs = _inputs_list(args)
    if len(inputs) < 2:
        fail("Merge needs at least two input PDFs.")
        return
    out = fitz.open()
    total = 0
    for path in inputs:
        try:
            src = fitz.open(path)
        except Exception as exc:
            out.close()
            fail(f"Could not open '{os.path.basename(path)}': {exc}")
            return
        out.insert_pdf(src)
        total += src.page_count
        src.close()
    out.save(args.output, garbage=4, clean=True, deflate=True)
    out.close()
    emit({"ok": True, "engine": "pymupdf", "action": "merge",
          "inputs": len(inputs), "pages": total})


def cmd_split(args):
    """Split into multiple PDFs. Either explicit --ranges '1-3,4-6' (one output
    per range) or --every N (fixed chunk size). Output is a ZIP of PDFs."""
    import fitz
    doc = open_pdf(args.input)
    n = doc.page_count
    groups = []
    if getattr(args, "ranges", None):
        for part in args.ranges.split(","):
            idx = parse_page_spec(part, n)
            if idx:
                groups.append(idx)
    elif getattr(args, "every", None):
        step = max(1, int(args.every))
        for start in range(0, n, step):
            groups.append(list(range(start, min(start + step, n))))
    else:
        groups = [[i] for i in range(n)]  # one page per file

    buf = io.BytesIO()
    made = 0
    stem = args.stem or "part"
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for gi, idx in enumerate(groups):
            part = fitz.open()
            for i in idx:
                part.insert_pdf(doc, from_page=i, to_page=i)
            pb = part.tobytes(garbage=4, clean=True, deflate=True)
            part.close()
            zf.writestr(f"{stem}-{gi + 1:03d}.pdf", pb)
            made += 1
    doc.close()
    with open(args.output, "wb") as fh:
        fh.write(buf.getvalue())
    emit({"ok": True, "engine": "pymupdf", "action": "split", "files": made})


def cmd_extract(args):
    """Pull a set of pages into one new PDF (keeps given order)."""
    import fitz
    doc = open_pdf(args.input)
    idx = parse_page_spec(getattr(args, "ranges", None) or args.pages, doc.page_count)
    if not idx:
        doc.close()
        fail("No valid pages to extract.")
        return
    out = fitz.open()
    for i in idx:
        out.insert_pdf(doc, from_page=i, to_page=i)
    out.save(args.output, garbage=4, clean=True, deflate=True)
    out.close(); doc.close()
    emit({"ok": True, "engine": "pymupdf", "action": "extract", "pages": len(idx)})


def cmd_rotate(args):
    """Rotate given pages by --angle (90/180/270, cumulative on existing)."""
    import fitz
    doc = open_pdf(args.input)
    idx = parse_page_spec(getattr(args, "ranges", None) or args.pages, doc.page_count)
    angle = int(args.angle or 90) % 360
    for i in idx:
        page = doc[i]
        page.set_rotation((page.rotation + angle) % 360)
    doc.save(args.output, garbage=4, clean=True, deflate=True)
    doc.close()
    emit({"ok": True, "engine": "pymupdf", "action": "rotate",
          "pages": len(idx), "angle": angle})


def cmd_delete(args):
    """Delete the given pages; the rest keep their order."""
    import fitz
    doc = open_pdf(args.input)
    n = doc.page_count
    idx = set(parse_page_spec(getattr(args, "ranges", None) or args.pages, n))
    if not idx:
        doc.close(); fail("No valid pages to delete."); return
    if len(idx) >= n:
        doc.close(); fail("Refusing to delete every page."); return
    keep = [i for i in range(n) if i not in idx]
    doc.select(keep)  # select() reorders/keeps only these
    doc.save(args.output, garbage=4, clean=True, deflate=True)
    doc.close()
    emit({"ok": True, "engine": "pymupdf", "action": "delete",
          "deleted": len(idx), "remaining": len(keep)})


def cmd_reorder(args):
    """Reorder pages to an explicit --order '3,1,2' (1-based, must be a full
    permutation of all pages)."""
    import fitz
    doc = open_pdf(args.input)
    n = doc.page_count
    order = parse_page_spec(args.order, n) if getattr(args, "order", None) else []
    if sorted(order) != list(range(n)):
        doc.close()
        fail("Reorder needs a full permutation of every page exactly once.")
        return
    doc.select(order)
    doc.save(args.output, garbage=4, clean=True, deflate=True)
    doc.close()
    emit({"ok": True, "engine": "pymupdf", "action": "reorder", "pages": n})


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #
COMMANDS = {
    "compress": cmd_compress,
    "repair": cmd_repair,
    "unlock": cmd_unlock,
    "pdf-crack": cmd_pdf_crack,
    "protect": cmd_protect,
    "pdfa": cmd_pdfa,
    "pdf-to-images": cmd_pdf_to_images,
    "pdf-to-excel": cmd_pdf_to_excel,
    "pdf-to-word": cmd_pdf_to_word,
    "pdf-to-ppt": cmd_pdf_to_ppt,
    "remove-watermark": cmd_remove_watermark,
    "redact-regions": cmd_redact_regions,
    "compare": cmd_compare,
    "summarize": cmd_summarize,
    "page-png": cmd_page_png,
    "ocr": cmd_ocr,
    "ocr-pdf": cmd_ocr_pdf,
    "merge": cmd_merge,
    "split": cmd_split,
    "extract": cmd_extract,
    "rotate": cmd_rotate,
    "delete": cmd_delete,
    "reorder": cmd_reorder,
}


def build_parser():
    p = argparse.ArgumentParser(description="Local PDF Studio engine")
    p.add_argument("command")
    p.add_argument("--input")
    p.add_argument("--input2")
    p.add_argument("--output")
    p.add_argument("--password")
    p.add_argument("--owner-password")
    p.add_argument("--level", default="medium")
    p.add_argument("--dpi", type=int)
    p.add_argument("--quality", type=int)
    p.add_argument("--img-format")
    p.add_argument("--stem")
    p.add_argument("--title")
    p.add_argument("--mode")
    p.add_argument("--text")
    p.add_argument("--pages", default="all")
    p.add_argument("--page", type=int)
    p.add_argument("--rect", type=float, nargs=4)
    p.add_argument("--no-print", action="store_true")
    p.add_argument("--no-copy", action="store_true")
    p.add_argument("--no-edit", action="store_true")
    # Organize (merge/split/extract/rotate/delete/reorder)
    p.add_argument("--inputs-json")       # JSON array of paths, for merge
    p.add_argument("--regions-json")      # [{page, rect:[x0,y0,x1,y1]}], for redact-regions
    p.add_argument("--sentences", type=int)  # target summary length, for summarize
    p.add_argument("--ranges")            # '1-3,5,7-9'
    p.add_argument("--every", type=int)   # split into fixed chunks
    p.add_argument("--angle", type=int)   # rotate
    p.add_argument("--order")             # reorder permutation '3,1,2'
    # OCR
    p.add_argument("--lang", default="eng")             # tesseract-style code, e.g. 'eng+hin'
    p.add_argument("--backend", default="auto")         # auto | rapidocr | tesseract
    p.add_argument("--force-ocr", action="store_true")  # recognise even if a text layer exists
    p.add_argument("--no-deskew", action="store_true")
    p.add_argument("--no-enhance", action="store_true")
    p.add_argument("--min-confidence", type=float)
    # Password recovery (pdf-crack)
    p.add_argument("--crack-mode", choices=["pin", "dictionary", "charset"])
    p.add_argument("--min-len", type=int)
    p.add_argument("--max-len", type=int)
    p.add_argument("--charset")
    p.add_argument("--wordlist")            # path to an uploaded custom word list, one password per line
    p.add_argument("--max-seconds", type=int)
    return p


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "capabilities":
        emit({"ok": True, **probe_capabilities()})
        return
    args = build_parser().parse_args()
    handler = COMMANDS.get(args.command)
    if not handler:
        fail(f"Unknown command: {args.command}")
        return
    try:
        handler(args)
    except SystemExit:
        raise
    except ModuleNotFoundError as exc:
        fail(f"Missing Python package: {exc.name}", missing=exc.name)
    except Exception as exc:
        fail(f"{args.command} failed: {exc}")


if __name__ == "__main__":
    main()
