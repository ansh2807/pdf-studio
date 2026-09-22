// Turns raw pointer-move samples (jagged, noisy, sometimes bunched up when
// the mouse pauses) into a natural-looking pen stroke - what the Pen and
// Sign tools actually draw, both live on screen and in the exported PDF.
// This is the same two-step approach real signature-capture software uses:
//   1. Ramer-Douglas-Peucker simplification removes redundant points that
//      don't meaningfully change the stroke's shape, without losing real
//      corners/direction changes.
//   2. A centripetal Catmull-Rom spline through the simplified points
//      produces a smooth curve that still passes exactly through every
//      point (unlike a Bezier fit, which would need to APPROXIMATE the
//      input and could drift from what was actually drawn).
// Centripetal (alpha=0.5) parameterization specifically avoids the loops and
// self-intersections a uniform Catmull-Rom spline produces when consecutive
// points are unevenly spaced - exactly the case for real pointer input,
// where fast strokes leave sparse points and slow ones leave dense clusters.

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

// Ramer-Douglas-Peucker: recursively keep only the point(s) that deviate
// from the straight line between the segment's endpoints by more than
// `tolerance`, discarding the rest.
export function simplifyPoints(points, tolerance = 0.0015) {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let maxIndex = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i += 1) {
    const dist = distanceToSegment(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }
  if (maxDist > tolerance) {
    const left = simplifyPoints(points.slice(0, maxIndex + 1), tolerance);
    const right = simplifyPoints(points.slice(maxIndex), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

// One centripetal Catmull-Rom segment between p1 and p2 (with neighbors p0,
// p3 for tangent direction), evaluated at `samples` points along it.
function catmullRomSegment(p0, p1, p2, p3, samples) {
  const alpha = 0.5;
  const getT = (t, pa, pb) => {
    const d = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1e-6;
    return t + d ** alpha;
  };
  const t0 = 0;
  const t1 = getT(t0, p0, p1);
  const t2 = getT(t1, p1, p2);
  const t3 = getT(t2, p2, p3);
  const out = [];
  for (let s = 0; s < samples; s += 1) {
    const t = t1 + ((t2 - t1) * s) / samples;
    const a1x = ((t1 - t) / (t1 - t0)) * p0.x + ((t - t0) / (t1 - t0)) * p1.x;
    const a1y = ((t1 - t) / (t1 - t0)) * p0.y + ((t - t0) / (t1 - t0)) * p1.y;
    const a2x = ((t2 - t) / (t2 - t1)) * p1.x + ((t - t1) / (t2 - t1)) * p2.x;
    const a2y = ((t2 - t) / (t2 - t1)) * p1.y + ((t - t1) / (t2 - t1)) * p2.y;
    const a3x = ((t3 - t) / (t3 - t2)) * p2.x + ((t - t2) / (t3 - t2)) * p3.x;
    const a3y = ((t3 - t) / (t3 - t2)) * p2.y + ((t - t2) / (t3 - t2)) * p3.y;
    const b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x;
    const b1y = ((t2 - t) / (t2 - t0)) * a1y + ((t - t0) / (t2 - t0)) * a2y;
    const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x;
    const b2y = ((t3 - t) / (t3 - t1)) * a2y + ((t - t1) / (t3 - t1)) * a3y;
    const cx = ((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x;
    const cy = ((t2 - t) / (t2 - t1)) * b1y + ((t - t1) / (t2 - t1)) * b2y;
    out.push({ x: Number.isFinite(cx) ? cx : p1.x, y: Number.isFinite(cy) ? cy : p1.y });
  }
  return out;
}

// Resamples a simplified point sequence into a dense, smooth curve. Used
// directly for the live SVG preview path, and for building the many short
// straight segments that approximate the curve in the exported PDF (pdf-lib
// only draws straight lines, so a smooth-LOOKING curve there is many small
// segments along this same spline, not a real Bezier primitive).
export function smoothPoints(rawPoints, { tolerance = 0.0015, samplesPerSegment = 8 } = {}) {
  const points = simplifyPoints(rawPoints, tolerance);
  if (points.length < 3) return points;
  const padded = [points[0], ...points, points[points.length - 1]];
  const result = [points[0]];
  for (let i = 1; i < padded.length - 2; i += 1) {
    const seg = catmullRomSegment(padded[i - 1], padded[i], padded[i + 1], padded[i + 2], samplesPerSegment);
    result.push(...seg);
  }
  result.push(points[points.length - 1]);
  return result;
}

// SVG path `d` string through the smoothed points, for the live ink-layer
// preview - a plain polyline through the densely-resampled curve points
// already reads as smooth at typical stroke widths, without needing SVG's
// own cubic-bezier path commands.
export function smoothPathD(rawPoints, pageWidth, pageHeight, options) {
  const smoothed = smoothPoints(rawPoints, options);
  return smoothed
    .map((point, index) => `${index ? "L" : "M"} ${point.x * pageWidth} ${point.y * pageHeight}`)
    .join(" ");
}
