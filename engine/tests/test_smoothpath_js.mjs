// Tests for src/lib/smoothPath.js - the Ramer-Douglas-Peucker simplification
// + centripetal Catmull-Rom smoothing used by the Pen and Sign tools, both
// for the live on-screen stroke and for what gets baked into the exported
// PDF (replacing raw jagged mouse-point polylines).
import assert from "node:assert/strict";
import { simplifyPoints, smoothPoints, smoothPathD } from "../../src/lib/smoothPath.js";

const RESULTS = [];
function chk(name, cond, detail) {
  RESULTS.push([name, !!cond]);
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
}

// ---------- simplifyPoints: removes noise, keeps real corners ----------
{
  // A near-straight horizontal line with lots of tiny jitter (typical of a
  // slow, noisy pointermove sample stream) should collapse to very few
  // points once simplified.
  const noisyLine = [];
  for (let i = 0; i <= 40; i += 1) {
    noisyLine.push({ x: i / 40, y: 0.5 + (i % 2 === 0 ? 0.0002 : -0.0002) });
  }
  const simplified = simplifyPoints(noisyLine, 0.0015);
  chk("noisy near-straight line collapses to far fewer points", simplified.length < 6, simplified.length);
  chk("simplified line keeps its start point", simplified[0].x === 0 && simplified[0].y === noisyLine[0].y);
  chk("simplified line keeps its end point", simplified[simplified.length - 1].x === 1);
}

{
  // A sharp "V" shape (real direction change) must NOT be simplified away -
  // the corner is real signal, not noise, and RDP's whole point is to keep it.
  const vShape = [];
  for (let i = 0; i <= 10; i += 1) vShape.push({ x: i / 20, y: i / 20 });
  for (let i = 1; i <= 10; i += 1) vShape.push({ x: 0.5 + i / 20, y: 0.5 - i / 20 });
  const simplified = simplifyPoints(vShape, 0.0015);
  const hasCorner = simplified.some((p) => Math.abs(p.x - 0.5) < 0.03 && Math.abs(p.y - 0.5) < 0.03);
  chk("a real sharp corner is preserved, not simplified away", hasCorner, simplified);
}

// ---------- smoothPoints: stays close to input, doesn't blow up ----------
{
  const raw = [{ x: 0, y: 0 }, { x: 0.2, y: 0.3 }, { x: 0.5, y: 0.1 }, { x: 0.8, y: 0.4 }, { x: 1, y: 0.2 }];
  const smoothed = smoothPoints(raw, { tolerance: 0, samplesPerSegment: 6 });
  chk("smoothing produces more points than the input (a real curve, not a pass-through)", smoothed.length > raw.length, smoothed.length);
  chk("smoothed curve starts at the same point as the input", Math.abs(smoothed[0].x - raw[0].x) < 1e-6 && Math.abs(smoothed[0].y - raw[0].y) < 1e-6);
  chk("smoothed curve ends at the same point as the input", Math.abs(smoothed[smoothed.length - 1].x - raw[raw.length - 1].x) < 1e-6);
  // The curve should stay reasonably close to the original polyline's
  // bounding box - a broken spline (e.g. a divide-by-zero from duplicate
  // points) would send coordinates to NaN or wildly out of range.
  const allFinite = smoothed.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  chk("every smoothed point is a finite number (no NaN/Infinity from the spline math)", allFinite);
  const inRange = smoothed.every((p) => p.x >= -0.5 && p.x <= 1.5 && p.y >= -0.5 && p.y <= 1.5);
  chk("smoothed curve stays near the input's bounding box, doesn't diverge", inRange);
}

{
  // Two points (the minimum a real stroke can have) and duplicate/degenerate
  // input must not crash - a user can tap-and-release without dragging.
  chk("two points does not crash and returns something drawable", smoothPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }]).length >= 2);
  chk("a single point does not crash", smoothPoints([{ x: 0.5, y: 0.5 }]).length >= 1);
  const dup = [{ x: 0.3, y: 0.3 }, { x: 0.3, y: 0.3 }, { x: 0.3, y: 0.3 }, { x: 0.5, y: 0.5 }];
  const dupSmoothed = smoothPoints(dup, { tolerance: 0 });
  chk("duplicate consecutive points don't produce NaN", dupSmoothed.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), dupSmoothed);
}

// ---------- smoothPathD: valid SVG path syntax ----------
{
  const raw = [{ x: 0, y: 0 }, { x: 0.3, y: 0.5 }, { x: 0.7, y: 0.2 }, { x: 1, y: 1 }];
  const d = smoothPathD(raw, 600, 800, { tolerance: 0 });
  chk("path starts with a moveto command", d.startsWith("M "));
  chk("path contains lineto commands", d.includes("L "));
  chk("path has no NaN in it", !d.includes("NaN"));
}

const passed = RESULTS.filter(([, ok]) => ok).length;
console.log(`\nSMOOTHPATH: ${passed}/${RESULTS.length} passed`);
console.log("RESULT:", passed === RESULTS.length ? "PASS" : "FAIL");
process.exit(passed === RESULTS.length ? 0 : 1);
