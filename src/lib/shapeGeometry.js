// Shape geometry for the canvas draw tools (Box/Ellipse/Line/Arrow/Highlight/
// Redact/Note/Text/Stamp/Check) and for exporting them into real PDF coordinates.
//
// One representation, three consumers: move (drag), resize (handle drag), and
// nudge (arrow keys) all edit the SAME {x,y,w,h[,x1,y1,x2,y2]} shape and must
// keep line/arrow endpoints in sync with their bounding box. Export then maps
// that normalized (0..1) shape into PDF page-space (which is Y-UP, while the
// editor's canvas is Y-DOWN, so every coordinate gets flipped once, here, in
// one place, instead of three slightly different times as before).

export function clampNum(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

const isLine = (shape) => shape.x1 != null;

// ---- move (drag the whole shape) ------------------------------------------ //
export function translateShape(shape, dx, dy) {
  const w = shape.w || 0;
  const h = shape.h || 0;
  const x = clampNum((shape.x || 0) + dx, 0, 1 - w);
  const y = clampNum((shape.y || 0) + dy, 0, 1 - h);
  const patch = { x, y };
  if (isLine(shape)) {
    const movedX = x - shape.x;
    const movedY = y - shape.y;
    patch.x1 = shape.x1 + movedX;
    patch.y1 = shape.y1 + movedY;
    patch.x2 = shape.x2 + movedX;
    patch.y2 = shape.y2 + movedY;
  }
  return patch;
}

// ---- nudge (arrow keys, no clamped-width-aware start point) --------------- //
export function nudgeShape(shape, dx, dy) {
  if (shape.points) {
    return { points: shape.points.map((p) => ({ x: clampNum(p.x + dx, 0, 1), y: clampNum(p.y + dy, 0, 1) })) };
  }
  return translateShape(shape, dx, dy);
}

// ---- resize from a corner handle ("n"/"s"/"e"/"w" combinations) ----------- //
export function resizeShape(shape, corner, dx, dy) {
  let { x, y, w, h } = shape;
  if (corner.includes("e")) w = clampNum(shape.w + dx, 0.02, 1 - shape.x);
  if (corner.includes("s")) h = clampNum(shape.h + dy, 0.02, 1 - shape.y);
  if (corner.includes("w")) {
    x = clampNum(shape.x + dx, 0, shape.x + shape.w - 0.02);
    w = shape.w + shape.x - x;
  }
  if (corner.includes("n")) {
    y = clampNum(shape.y + dy, 0, shape.y + shape.h - 0.02);
    h = shape.h + shape.y - y;
  }
  const patch = { x, y, w, h };
  if (isLine(shape) && shape.w > 0 && shape.h > 0) {
    // Keep the endpoints at the same RELATIVE position inside the new box, so
    // a diagonal line/arrow stays diagonal instead of snapping to an edge.
    patch.x1 = x + ((shape.x1 - shape.x) / shape.w) * w;
    patch.y1 = y + ((shape.y1 - shape.y) / shape.h) * h;
    patch.x2 = x + ((shape.x2 - shape.x) / shape.w) * w;
    patch.y2 = y + ((shape.y2 - shape.y) / shape.h) * h;
  }
  return patch;
}

// ---- duplicate offset ------------------------------------------------------ //
export function offsetForDuplicate(shape, delta = 0.025) {
  const patch = {
    x: clampNum((shape.x || 0) + delta, 0, 0.96),
    y: clampNum((shape.y || 0) + delta, 0, 0.96),
  };
  if (shape.points) {
    patch.points = shape.points.map((p) => ({ x: clampNum(p.x + delta, 0, 1), y: clampNum(p.y + delta, 0, 1) }));
  }
  if (isLine(shape)) {
    patch.x1 = clampNum(shape.x1 + delta, 0, 1);
    patch.y1 = clampNum(shape.y1 + delta, 0, 1);
    patch.x2 = clampNum(shape.x2 + delta, 0, 1);
    patch.y2 = clampNum(shape.y2 + delta, 0, 1);
  }
  return patch;
}

// ---- normalized (0..1, Y-DOWN) -> PDF page space (points, Y-UP) ----------- //
// This is the ONE place the Y-flip happens. Box tools, line/arrow endpoints,
// and freehand points must all go through this so what you see in the editor
// is exactly where it lands in the exported PDF.
export function toPdfPoint(nx, ny, pageSize) {
  return { x: nx * pageSize.width, y: pageSize.height - ny * pageSize.height };
}

export function toPdfBox(shape, pageSize) {
  const x = shape.x * pageSize.width;
  const y = pageSize.height - shape.y * pageSize.height - shape.h * pageSize.height;
  return { x, y, width: shape.w * pageSize.width, height: shape.h * pageSize.height };
}

// Line/arrow endpoints fall back to the bounding box's corners when x1/y1/x2/y2
// are absent (defensive - keeps old-shape data exportable).
export function toPdfLineEndpoints(shape, pageSize) {
  const start = toPdfPoint(shape.x1 ?? shape.x, shape.y1 ?? (shape.y + shape.h), pageSize);
  const end = toPdfPoint(shape.x2 ?? (shape.x + shape.w), shape.y2 ?? shape.y, pageSize);
  return { start, end };
}
