// Crop-rectangle math shared by Photo Studio's crop tool, resize-to-exact-size,
// and the passport/visa presets. Extracted and FIXED: the original clampRect
// recomputed one dimension to satisfy the aspect ratio but never re-checked
// the result against the image bounds (W, H). A tall aspect ratio combined
// with a crop rect close to the image's width could end up TALLER than the
// photo itself; then clamping x/y (with W-w or H-h now NEGATIVE) pushed the
// rectangle further off the image instead of fixing it - a broken/black
// crop preview or a canvas draw error on export.

export function clampNum(value, min, max) {
  // Guard against an inverted range (min > max, e.g. from an over-size rect)
  // instead of silently returning the wrong bound.
  if (min > max) return min;
  return Math.min(max, Math.max(min, value));
}

// Largest centered rectangle of the given aspect that fits inside W x H.
export function centeredCrop(W, H, aspect) {
  if (!aspect) return { x: 0, y: 0, w: W, h: H };
  let w = W;
  let h = W / aspect;
  if (h > H) {
    h = H;
    w = H * aspect;
  }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

// Clamp an arbitrary rect to fit within W x H, optionally locking an aspect
// ratio. Guarantees the result never exceeds the image bounds, however the
// aspect correction pushes a dimension.
export function clampRect(rect, W, H, aspect) {
  let { x, y, w, h } = rect;
  w = Math.min(Math.max(8, w), W);
  h = Math.min(Math.max(8, h), H);
  if (aspect) {
    if (w / h > aspect) w = h * aspect;
    else h = w / aspect;
    // The aspect correction above can push either dimension back OVER its
    // bound (e.g. h was already near H, and a wide aspect inflates w past W).
    // Re-clamp, preserving aspect, in a fixed point: shrinking to fit W can
    // only ever shrink h too, so a second check for H afterwards is enough.
    if (w > W) { w = W; h = w / aspect; }
    if (h > H) { h = H; w = h * aspect; }
  }
  x = clampNum(x, 0, W - w);
  y = clampNum(y, 0, H - h);
  return { x, y, w, h };
}
