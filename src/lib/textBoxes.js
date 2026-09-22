// Pure geometry for turning detected text into normalized (0..1) editor boxes.
//
// Extracted from App.jsx so the coordinate math - the part that, when wrong,
// makes an edit box land offset from the word you clicked - can be unit-tested
// without a live pdf.js viewport or a Tesseract run.

export function clampNum(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

// pdf.js text item -> normalized box. `transform` is the 6-element matrix from
// pdfjsLib.Util.transform(viewport.transform, item.transform) (computed by the
// caller, so this stays free of the pdf.js dependency and is testable).
export function normalizedBoxFromTransform(transform, item, viewport) {
  const scale = viewport.scale || 1;
  const fontHeight = Math.max(
    6,
    Math.hypot(transform[2], transform[3]) || (item.height || 10) * scale,
  );
  const width = Math.max(8, (item.width || 20) * scale);
  const x = transform[4];
  const y = transform[5] - fontHeight; // baseline -> top of glyph box
  return {
    x: clampNum(x / viewport.width, 0, 1),
    y: clampNum(y / viewport.height, 0, 1),
    w: clampNum(width / viewport.width, 0.01, 1),
    h: clampNum((fontHeight * 1.35) / viewport.height, 0.01, 0.2),
    fontSize: clampNum(Math.round(fontHeight / scale), 6, 96),
  };
}

// One Tesseract line/word -> normalized box. Accepts both bbox conventions:
// {x0,y0,x1,y1} and {left,top,width,height}. sourceWidth/Height are the canvas
// pixel dimensions OCR ran on; pageSize is the unscaled PDF page size (points).
export function ocrBoxToNormalized(item, sourceWidth, sourceHeight, pageSize) {
  const bbox = item.bbox || {};
  const x0 = bbox.x0 ?? bbox.left ?? 0;
  const y0 = bbox.y0 ?? bbox.top ?? 0;
  const x1 = bbox.x1 ?? ((bbox.left ?? 0) + (bbox.width ?? 0));
  const y1 = bbox.y1 ?? ((bbox.top ?? 0) + (bbox.height ?? 0));
  const width = Math.max(8, x1 - x0);
  const height = Math.max(8, y1 - y0);
  const ph = (pageSize && pageSize.height) || sourceHeight || 1;
  return {
    str: String(item.text || "").trim(),
    x: clampNum(x0 / sourceWidth, 0, 1),
    y: clampNum(y0 / sourceHeight, 0, 1),
    w: clampNum(width / sourceWidth, 0.01, 1),
    h: clampNum((height * 1.15) / sourceHeight, 0.01, 0.2),
    fontSize: clampNum(Math.round((height / sourceHeight) * ph * 0.86), 8, 72),
    confidence: Math.round(item.confidence || 0),
  };
}

// Hit-test: is a normalized point inside a detected box (with a small tolerance)?
// Used when the user clicks a word to edit it. Returns the best (nearest-center)
// match so overlapping fragments resolve to the one actually clicked.
export function findBoxAtPoint(items, point, tolX = 0.004, tolY = 0.006) {
  let best = null;
  let bestDist = Infinity;
  for (const it of items) {
    const inside =
      point.x >= it.x - tolX && point.x <= it.x + it.w + tolX &&
      point.y >= it.y - tolY && point.y <= it.y + it.h + tolY;
    if (!inside) continue;
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    const d = (point.x - cx) ** 2 + (point.y - cy) ** 2;
    if (d < bestDist) { bestDist = d; best = it; }
  }
  return best;
}
