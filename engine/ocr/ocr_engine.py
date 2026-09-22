#!/usr/bin/env python3
"""
OCR engine (production).

Replaces the browser-only `tesseract.js` path in src/App.jsx, which fails in
two ways that look identical to the user ("OCR Page does nothing"):

  1. It downloads its worker, WASM core and the language `.traineddata` from a
     CDN on first use. Offline, behind a proxy, or on a locked-down network
     that is a hard failure, and the only feedback was a generic
     "OCR failed. Check your connection..." status.
  2. Even when it does run, it OCRs whatever the viewer canvas happens to hold
     - i.e. the page at the CURRENT ZOOM, often ~96 DPI, un-deskewed, with no
     contrast work. Tesseract LSTM needs roughly 300 DPI of clean, upright
     text; feeding it a 96 DPI screen render of a phone-camera scan is why the
     output was garbage on exactly the documents OCR exists for.

This module does the job properly, on the server, with no network at runtime:

  * Renders from the PDF itself at a resolution chosen for the recogniser,
    not from the on-screen canvas.
  * Deskews (real scans are 0.5-3 degrees off), and lifts contrast on faint
    or grey-background scans before recognition.
  * Recognises with PP-OCRv4 (PaddleOCR's detection + recognition models,
    ONNX) through the `onnxruntime` this project already ships for LaMa and
    U2Net. Detection-based, so it handles skewed/curved/rotated lines and
    photos of documents, which is where Tesseract's page-segmentation falls
    apart.
  * Falls back to a native Tesseract binary when one is installed, which is
    what covers the long tail of languages (Hindi, Tamil, Arabic, ...) that
    the bundled PP-OCR recognition model does not.
  * Returns WORD boxes, not just line boxes, so the editor can make each word
    separately editable.

Coordinates come back in the pixel space of the image that was passed in
(pre-deskew, pre-resize) - the caller does not have to know anything about the
internal preprocessing.

Optional dependency: `rapidocr-onnxruntime` (bundles the PP-OCRv4 ONNX models
in its wheel, ~16 MB, no runtime download). Degrades to Tesseract, and then to
"unavailable" - at which point the caller is expected to fall back to the
browser engine rather than pretend the page has no text.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile

import cv2
import numpy as np

# --------------------------------------------------------------------------- #
# Backend discovery
# --------------------------------------------------------------------------- #

# PP-OCRv4's bundled recognition model is the Chinese+English one: its
# character dictionary covers Latin letters, digits, punctuation and CJK. Any
# other script (Devanagari, Arabic, Cyrillic, Thai, ...) would come back as
# confident-looking nonsense, so those languages must go to Tesseract or back
# to the browser instead. Being explicit here is what stops a Hindi scan from
# silently producing garbage - the exact class of bug this engine replaces.
_RAPID_LANGS = {"eng", "chi_sim", "chi_tra", "eng+chi_sim", "chi_sim+eng"}

_rapid = None
_rapid_load_attempted = False


def rapidocr_available() -> bool:
    try:
        import rapidocr_onnxruntime  # noqa: F401
    except Exception:
        return False
    try:
        import onnxruntime  # noqa: F401
    except Exception:
        return False
    return True


def _get_rapid():
    """Lazily build the RapidOCR pipeline (model load is ~2-3s, once)."""
    global _rapid, _rapid_load_attempted
    if _rapid is not None or _rapid_load_attempted:
        return _rapid
    _rapid_load_attempted = True
    try:
        from rapidocr_onnxruntime import RapidOCR
        _rapid = RapidOCR()
    except Exception:
        _rapid = None
    return _rapid


def tesseract_path() -> str | None:
    """Native tesseract binary, if this machine has one."""
    env = os.environ.get("TESSERACT_BIN")
    if env and os.path.isfile(env):
        return env
    found = shutil.which("tesseract")
    if found:
        return found
    for candidate in (
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe"),
        "/usr/bin/tesseract",
        "/usr/local/bin/tesseract",
        "/opt/homebrew/bin/tesseract",
    ):
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def tesseract_languages() -> list[str]:
    exe = tesseract_path()
    if not exe:
        return []
    try:
        out = subprocess.run(
            [exe, "--list-langs"], capture_output=True, text=True, timeout=20,
        )
    except Exception:
        return []
    langs = []
    for line in (out.stdout or "").splitlines():
        line = line.strip()
        if not line or line.lower().startswith("list of"):
            continue
        langs.append(line)
    return sorted(langs)


def ocr_available() -> bool:
    return rapidocr_available() or bool(tesseract_path())


def capabilities() -> dict:
    """What the Node bridge reports to the front-end, so the UI can say which
    engine will actually run instead of guessing."""
    tess = tesseract_path()
    tess_langs = tesseract_languages() if tess else []
    langs = sorted(set(list(_RAPID_LANGS if rapidocr_available() else []) + tess_langs))
    return {
        "available": ocr_available(),
        "rapidocr": rapidocr_available(),
        "tesseract": bool(tess),
        "tesseractPath": tess,
        "tesseractLanguages": tess_langs,
        "languages": langs,
        "engineName": (
            "PP-OCRv4 (ONNX)" if rapidocr_available()
            else "Tesseract" if tess
            else None
        ),
    }


def supports_language(lang: str) -> bool:
    lang = (lang or "eng").strip()
    if lang in _RAPID_LANGS and rapidocr_available():
        return True
    tess_langs = set(tesseract_languages())
    if tess_langs and all(part in tess_langs for part in lang.split("+")):
        return True
    return False


def pick_backend(lang: str, requested: str = "auto") -> str | None:
    """Which engine should handle this language. `None` means neither can, and
    the caller should fall back to the browser rather than return junk."""
    lang = (lang or "eng").strip()
    requested = (requested or "auto").lower()
    if requested == "rapidocr":
        return "rapidocr" if rapidocr_available() else None
    if requested == "tesseract":
        return "tesseract" if tesseract_path() else None
    # auto: PP-OCRv4 is the stronger engine on real scans and photos, so it
    # wins for the languages its model actually covers; everything else is
    # Tesseract's job (it has the traineddata for the long tail).
    if lang in _RAPID_LANGS and rapidocr_available():
        return "rapidocr"
    tess_langs = set(tesseract_languages())
    if tess_langs and all(part in tess_langs for part in lang.split("+")):
        return "tesseract"
    if rapidocr_available() and lang in _RAPID_LANGS:
        return "rapidocr"
    return None


# --------------------------------------------------------------------------- #
# Preprocessing
#
# Every step here is undone in coordinate space afterwards (see `_Transform`),
# so boxes are reported against the ORIGINAL image the caller handed in.
# --------------------------------------------------------------------------- #

# PP-OCR's detector internally caps the long side at 2000px anyway, so
# rendering or feeding it anything much larger is pure cost. 2400 leaves a
# little headroom for the deskew rotation without throwing away detail.
MAX_SIDE = 2400
MIN_SIDE = 640


class _Transform:
    """Records resize + rotation so detected points can be mapped back.

    Forward:  original --(scale s)--> resized --(affine M)--> processed
    Inverse:  processed --(M^-1)--> resized --(/s)--> original
    """

    def __init__(self, scale: float = 1.0, matrix: np.ndarray | None = None):
        self.scale = scale or 1.0
        self.matrix = matrix

    def to_original(self, points: np.ndarray) -> np.ndarray:
        pts = np.asarray(points, dtype=np.float64).reshape(-1, 2)
        if self.matrix is not None:
            inv = cv2.invertAffineTransform(self.matrix)
            ones = np.ones((pts.shape[0], 1), dtype=np.float64)
            pts = (np.hstack([pts, ones]) @ inv.T)
        return pts / self.scale


def _to_bgr(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    return img


def estimate_skew(gray: np.ndarray) -> float:
    """Skew angle in degrees (positive = image must rotate counter-clockwise).

    Uses the minimum-area rectangle around the ink, which is the standard,
    dependency-free approach and is stable on forms and dense text alike.
    Returns 0.0 when the estimate is implausible - a wrong rotation is far
    worse than none, so anything beyond +/-15 degrees is treated as "this is
    not skew, it's the document's layout" and left alone.
    """
    if gray.size == 0:
        return 0.0
    work = gray
    long_side = max(work.shape[:2])
    if long_side > 1200:  # skew estimation does not need full resolution
        f = 1200.0 / long_side
        work = cv2.resize(work, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
    inverted = cv2.bitwise_not(work)
    _, binary = cv2.threshold(inverted, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    # Bridge characters into words/lines so the rectangle follows text lines
    # rather than individual glyphs.
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 3))
    binary = cv2.dilate(binary, kernel, iterations=2)
    coords = cv2.findNonZero(binary)
    if coords is None or len(coords) < 50:
        return 0.0
    angle = cv2.minAreaRect(coords)[-1]
    if angle > 45:
        angle -= 90
    elif angle < -45:
        angle += 90
    if abs(angle) > 15 or not np.isfinite(angle):
        return 0.0
    return float(angle)


def _rotate(img: np.ndarray, angle: float):
    h, w = img.shape[:2]
    center = (w / 2.0, h / 2.0)
    matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
    cos, sin = abs(matrix[0, 0]), abs(matrix[0, 1])
    new_w = int(h * sin + w * cos)
    new_h = int(h * cos + w * sin)
    matrix[0, 2] += (new_w / 2.0) - center[0]
    matrix[1, 2] += (new_h / 2.0) - center[1]
    rotated = cv2.warpAffine(
        img, matrix, (new_w, new_h),
        flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE,
    )
    return rotated, matrix


def _enhance(img: np.ndarray) -> np.ndarray:
    """Lift contrast on faint / unevenly lit scans.

    Deliberately NOT a binarisation: PP-OCRv4 and Tesseract's LSTM are both
    trained on greyscale-ish input and lose accuracy on hard-thresholded
    images (thin strokes break up). CLAHE only stretches local contrast, so a
    pale fax or a phone photo with a shadow gradient becomes readable without
    destroying stroke detail.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if float(gray.std()) > 60:  # already crisp, leave it alone
        return img
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return cv2.cvtColor(clahe.apply(gray), cv2.COLOR_GRAY2BGR)


def preprocess(img_bgr: np.ndarray, deskew: bool = True, enhance: bool = True):
    """-> (processed image, _Transform, {'skewAngle': deg, 'scale': f})"""
    img = _to_bgr(img_bgr)
    h, w = img.shape[:2]
    scale = 1.0
    long_side = max(h, w)
    short_side = min(h, w)
    if long_side > MAX_SIDE:
        scale = MAX_SIDE / float(long_side)
    elif short_side and short_side < MIN_SIDE:
        # Tiny crops (a stamp, a single field) get upscaled - the recogniser
        # needs roughly 32px of glyph height to work with.
        scale = min(MIN_SIDE / float(short_side), 4.0)
    if scale != 1.0:
        interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=interp)

    if enhance:
        img = _enhance(img)

    angle = 0.0
    matrix = None
    if deskew:
        angle = estimate_skew(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
        if abs(angle) >= 0.25:  # below this, rotation costs more than it buys
            img, matrix = _rotate(img, angle)
        else:
            angle = 0.0

    return img, _Transform(scale, matrix), {"skewAngle": round(angle, 2), "scale": round(scale, 4)}


# --------------------------------------------------------------------------- #
# Word segmentation
# --------------------------------------------------------------------------- #

def _quad_to_bbox(points) -> dict:
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    return {
        "x0": float(pts[:, 0].min()),
        "y0": float(pts[:, 1].min()),
        "x1": float(pts[:, 0].max()),
        "y1": float(pts[:, 1].max()),
    }


CJK_RE = re.compile("[　-鿿豈-﫿가-힯]")  # CJK + Hangul blocks


def _looks_cjk(text: str) -> bool:
    """CJK scripts do not separate words with spaces, so word segmentation is
    meaningless there - the line IS the unit. Guarding on this stops a Chinese
    line from being exploded into one box per glyph."""
    letters = [c for c in text if not c.isspace()]
    if not letters:
        return False
    return sum(1 for c in letters if CJK_RE.match(c)) / len(letters) > 0.3


def ink_runs(gray_line: np.ndarray):
    """Column ranges holding ink in a single line crop, merged across gaps too
    narrow to be a space.

    This is what recovers the spaces PP-OCR's recognition model drops - its
    Chinese+English label set has no space class, so "2390 9580th Avenue"
    comes back as "23909580thAvenue". The gaps are still plainly there in the
    pixels; a vertical projection profile finds them.

    The threshold mixes two scales because either one alone misfires:
      * 0.13 x line height - an absolute floor tied to type size, so a line
        whose every gap is wide (a spaced-out heading) still splits.
      * 2.0 x the 25th-percentile gap - the line's own inter-letter spacing,
        so a tight condensed font is not split at every serif. The 25th
        percentile rather than the median because on a two-word line the
        median IS the space, which would suppress the very split we want.
    """
    if gray_line.size == 0:
        return []
    height = gray_line.shape[0]
    _, binary = cv2.threshold(gray_line, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    columns = (binary > 0).sum(axis=0)
    # A couple of stray pixels (a serif tail, scan speckle) must not bridge a
    # real space, so "blank" allows a small ink tolerance rather than zero.
    tolerance = max(0, int(round(0.03 * height)))
    blank = columns <= tolerance

    runs = []
    start = None
    for index, is_blank in enumerate(blank):
        if not is_blank and start is None:
            start = index
        elif is_blank and start is not None:
            runs.append([start, index - 1])
            start = None
    if start is not None:
        runs.append([start, len(blank) - 1])
    if len(runs) <= 1:
        return runs

    gaps = [runs[i + 1][0] - runs[i][1] - 1 for i in range(len(runs) - 1)]
    positive = [g for g in gaps if g > 0]
    p25 = float(np.percentile(positive, 25)) if positive else 0.0
    threshold = max(0.13 * height, 2.0 * p25)

    merged = [list(runs[0])]
    for run in runs[1:]:
        if run[0] - merged[-1][1] - 1 < threshold:
            merged[-1][1] = run[1]
        else:
            merged.append(list(run))
    return merged


def split_line_into_words(text, char_boxes, line_bbox, confidence, gray_line=None):
    """One recognised line -> per-word text + boxes.

    Per-word boxes matter for the editor: a whole-line box would force the
    user to retype an entire line to correct one misread word.

    Three sources of truth, in order of trust:
      1. Spaces the recogniser itself emitted (Tesseract always; PP-OCR
         sometimes) - never second-guessed.
      2. The pixels, via `ink_runs`, when the text came back with no spaces at
         all - this is the PP-OCR missing-space case.
      3. Proportional apportioning of the line box, when there is no usable
         geometry at all. Crude, but keeps every word clickable.
    """
    text = (text or "").strip()
    if not text:
        return []

    boxes = []
    for box in (char_boxes or []):
        try:
            boxes.append(_quad_to_bbox(box))
        except Exception:
            boxes = []
            break
    if len(boxes) != len(text):
        boxes = []

    def box_for(indices):
        """Union of the character boxes for one word."""
        if not boxes or not indices:
            return None
        xs0 = [boxes[i]["x0"] for i in indices]
        ys0 = [boxes[i]["y0"] for i in indices]
        xs1 = [boxes[i]["x1"] for i in indices]
        ys1 = [boxes[i]["y1"] for i in indices]
        return {"x0": min(xs0), "y0": min(ys0), "x1": max(xs1), "y1": max(ys1)}

    def apportion(start, end):
        """Slice of the line box covering characters [start, end)."""
        span = max(1, len(text))
        width = line_bbox["x1"] - line_bbox["x0"]
        return {
            "x0": line_bbox["x0"] + width * (start / span),
            "y0": line_bbox["y0"],
            "x1": line_bbox["x0"] + width * (end / span),
            "y1": line_bbox["y1"],
        }

    # ---- 1. The recogniser gave us spaces -------------------------------- #
    if any(c.isspace() for c in text):
        words = []
        for match in re.finditer(r"\S+", text):
            indices = list(range(match.start(), match.end()))
            words.append({
                "text": match.group(),
                "confidence": confidence,
                "bbox": box_for(indices) or apportion(match.start(), match.end()),
            })
        return words

    if _looks_cjk(text):
        return [{"text": text, "confidence": confidence, "bbox": dict(line_bbox)}]

    # ---- 2. No spaces: recover them from the pixels ----------------------- #
    runs = ink_runs(gray_line) if gray_line is not None else []
    if len(runs) > 1 and boxes:
        offset = line_bbox["x0"]
        spans = [(offset + a, offset + b) for a, b in runs]
        buckets = [[] for _ in spans]
        for index in range(len(text)):
            center = (boxes[index]["x0"] + boxes[index]["x1"]) / 2.0
            best = min(
                range(len(spans)),
                key=lambda i: 0.0 if spans[i][0] <= center <= spans[i][1]
                else min(abs(center - spans[i][0]), abs(center - spans[i][1])),
            )
            buckets[best].append(index)
        words = []
        for indices in buckets:
            if not indices:
                continue
            chunk = "".join(text[i] for i in indices).strip()
            if not chunk:
                continue
            words.append({
                "text": chunk,
                "confidence": confidence,
                "bbox": box_for(indices),
            })
        if words:
            return words

    # ---- 3. Nothing to segment on: one box for the line ------------------ #
    return [{"text": text, "confidence": confidence, "bbox": dict(line_bbox)}]


# PP-OCR's recognition head is the Chinese+English one, so on a purely
# English page it occasionally emits the FULLWIDTH form of a character it is
# more used to seeing in CJK text - "（2）" instead of "(2)". Those code points
# are not what a Latin document should contain, break search and copy-paste,
# and render as double-width boxes in the editor, so they are folded back to
# their ASCII equivalents unless the line is genuinely CJK.
_FULLWIDTH_OFFSET = 0xFEE0


def normalize_latin(text: str) -> str:
    if not text or _looks_cjk(text):
        return text
    out = []
    for ch in text:
        code = ord(ch)
        if 0xFF01 <= code <= 0xFF5E:
            out.append(chr(code - _FULLWIDTH_OFFSET))
        elif ch == "　":       # ideographic space
            out.append(" ")
        elif ch in "“”":   # curly double quotes
            out.append('"')
        elif ch in "‘’":   # curly single quotes
            out.append("'")
        else:
            out.append(ch)
    return "".join(out)


def _spaced_line_text(words) -> str:
    return " ".join(w["text"] for w in words).strip()


# --------------------------------------------------------------------------- #
# Recognition backends
# --------------------------------------------------------------------------- #

def _run_rapidocr(img: np.ndarray, text_score: float = 0.4):
    engine = _get_rapid()
    if engine is None:
        raise RuntimeError("PP-OCR engine failed to load")
    # return_word_box gives per-character quads, which is what makes the
    # space-recovery and per-word boxes above possible.
    result, _elapse = engine(img, return_word_box=True, text_score=text_score)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape[:2]
    lines = []
    for entry in (result or []):
        quad = entry[0]
        text = normalize_latin(entry[1])
        score = float(entry[2]) if len(entry) > 2 else 0.0
        char_boxes = entry[3] if len(entry) > 3 else None
        bbox = _quad_to_bbox(quad)
        # The line's own pixels, for the space-recovery projection profile.
        x0 = max(0, int(bbox["x0"])); x1 = min(width, int(bbox["x1"]) + 1)
        y0 = max(0, int(bbox["y0"])); y1 = min(height, int(bbox["y1"]) + 1)
        crop = gray[y0:y1, x0:x1] if x1 > x0 and y1 > y0 else None
        words = split_line_into_words(
            text, char_boxes, bbox, round(score * 100, 1), gray_line=crop,
        )
        if not words:
            continue
        lines.append({
            "text": _spaced_line_text(words),
            "confidence": round(score * 100, 1),
            "bbox": bbox,
            "quad": np.asarray(quad, dtype=np.float64).reshape(-1, 2).tolist(),
            "words": words,
        })
    return lines


def _run_tesseract(img: np.ndarray, lang: str = "eng", psm: int = 3):
    exe = tesseract_path()
    if not exe:
        raise RuntimeError("Tesseract is not installed on this machine")
    temp_dir = tempfile.mkdtemp(prefix="pdfstudio-ocr-")
    try:
        image_path = os.path.join(temp_dir, "page.png")
        cv2.imwrite(image_path, img)
        proc = subprocess.run(
            [exe, image_path, "stdout", "-l", lang, "--psm", str(psm), "--oem", "1", "tsv"],
            capture_output=True, text=True, timeout=300,
        )
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or "tesseract failed").strip().splitlines()[-1])
        return _parse_tesseract_tsv(proc.stdout)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def _parse_tesseract_tsv(tsv: str):
    """TSV -> the same line/word shape the PP-OCR path returns."""
    rows = [r.split("\t") for r in (tsv or "").splitlines() if r.strip()]
    if not rows:
        return []
    header = rows[0]
    try:
        idx = {name: header.index(name) for name in
               ("level", "block_num", "par_num", "line_num", "left", "top", "width", "height", "conf", "text")}
    except ValueError:
        return []
    grouped = {}
    for row in rows[1:]:
        if len(row) <= idx["text"]:
            continue
        if row[idx["level"]] != "5":  # 5 = word
            continue
        text = row[idx["text"]].strip()
        if not text:
            continue
        try:
            conf = float(row[idx["conf"]])
            left, top = float(row[idx["left"]]), float(row[idx["top"]])
            width, height = float(row[idx["width"]]), float(row[idx["height"]])
        except ValueError:
            continue
        if conf < 0:
            continue
        key = (row[idx["block_num"]], row[idx["par_num"]], row[idx["line_num"]])
        grouped.setdefault(key, []).append({
            "text": text,
            "confidence": round(conf, 1),
            "bbox": {"x0": left, "y0": top, "x1": left + width, "y1": top + height},
        })
    lines = []
    for _key, words in grouped.items():
        words.sort(key=lambda w: w["bbox"]["x0"])
        xs0 = [w["bbox"]["x0"] for w in words]
        ys0 = [w["bbox"]["y0"] for w in words]
        xs1 = [w["bbox"]["x1"] for w in words]
        ys1 = [w["bbox"]["y1"] for w in words]
        bbox = {"x0": min(xs0), "y0": min(ys0), "x1": max(xs1), "y1": max(ys1)}
        confidence = round(sum(w["confidence"] for w in words) / len(words), 1)
        lines.append({
            "text": _spaced_line_text(words),
            "confidence": confidence,
            "bbox": bbox,
            "quad": [[bbox["x0"], bbox["y0"]], [bbox["x1"], bbox["y0"]],
                     [bbox["x1"], bbox["y1"]], [bbox["x0"], bbox["y1"]]],
            "words": words,
        })
    lines.sort(key=lambda l: (round(l["bbox"]["y0"], 1), l["bbox"]["x0"]))
    return lines


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #

def _map_lines_to_original(lines, transform: _Transform, width: int, height: int):
    """Undo preprocessing in coordinate space and clamp into the image."""
    def fix_box(box):
        pts = transform.to_original([[box["x0"], box["y0"]], [box["x1"], box["y1"]]])
        x0, x1 = sorted((float(pts[0][0]), float(pts[1][0])))
        y0, y1 = sorted((float(pts[0][1]), float(pts[1][1])))
        return {
            "x0": max(0.0, min(x0, width)),
            "y0": max(0.0, min(y0, height)),
            "x1": max(0.0, min(x1, width)),
            "y1": max(0.0, min(y1, height)),
        }

    mapped = []
    for line in lines:
        words = []
        for word in line["words"]:
            box = fix_box(word["bbox"])
            if box["x1"] - box["x0"] < 1 or box["y1"] - box["y0"] < 1:
                continue
            words.append({**word, "bbox": box})
        if not words:
            continue
        quad = transform.to_original(line["quad"]).tolist() if line.get("quad") else None
        mapped.append({
            **line,
            "bbox": fix_box(line["bbox"]),
            "quad": [[float(x), float(y)] for x, y in (quad or [])],
            "words": words,
        })
    mapped.sort(key=lambda l: (round(l["bbox"]["y0"] / 6.0), l["bbox"]["x0"]))
    return mapped


def recognize(
    img_bgr: np.ndarray,
    lang: str = "eng",
    backend: str = "auto",
    deskew: bool = True,
    enhance: bool = True,
    min_confidence: float = 30.0,
    psm: int = 3,
) -> dict:
    """OCR one image.

    Returns
        {
          ok, engine, language, width, height, skewAngle,
          lines: [{text, confidence, bbox, quad, words: [{text, confidence, bbox}]}],
          words: [...],          # flattened, in reading order
          text:  "..."           # plain text, newline per line
        }

    `bbox` values are pixels in the coordinate space of `img_bgr` as passed in.
    """
    img_bgr = _to_bgr(img_bgr)
    height, width = img_bgr.shape[:2]
    chosen = pick_backend(lang, backend)
    if chosen is None:
        return {
            "ok": False,
            "error": (
                f"No installed OCR engine covers language '{lang}'."
                if ocr_available() else
                "No server OCR engine is installed."
            ),
            "unsupportedLanguage": ocr_available(),
            "engine": None,
            "languages": capabilities()["languages"],
        }

    processed, transform, info = preprocess(img_bgr, deskew=deskew, enhance=enhance)
    if chosen == "rapidocr":
        lines = _run_rapidocr(processed)
        engine_name = "PP-OCRv4 (ONNX)"
    else:
        lines = _run_tesseract(processed, lang=lang, psm=psm)
        engine_name = "Tesseract"

    lines = _map_lines_to_original(lines, transform, width, height)
    if min_confidence > 0:
        for line in lines:
            line["words"] = [w for w in line["words"] if w["confidence"] >= min_confidence]
        lines = [l for l in lines if l["words"]]
        for line in lines:
            line["text"] = _spaced_line_text(line["words"])

    words = [w for line in lines for w in line["words"]]
    return {
        "ok": True,
        "engine": engine_name,
        "backend": chosen,
        "language": lang,
        "width": width,
        "height": height,
        "skewAngle": info["skewAngle"],
        "lines": lines,
        "words": words,
        "text": "\n".join(line["text"] for line in lines),
        "meanConfidence": round(sum(w["confidence"] for w in words) / len(words), 1) if words else 0.0,
    }
