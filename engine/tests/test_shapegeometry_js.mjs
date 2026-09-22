// Unit tests for src/lib/shapeGeometry.js - move/resize/nudge/duplicate for
// canvas shapes, and the normalized-editor -> PDF-page-space export transform.
//   node engine/tests/test_shapegeometry_js.mjs
import {
  translateShape, nudgeShape, resizeShape, offsetForDuplicate,
  toPdfPoint, toPdfBox, toPdfLineEndpoints, clampNum,
} from "../../src/lib/shapeGeometry.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  cond ? pass++ : fail++;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const J = (x) => JSON.stringify(x);

// ---------- translate (box) ----------
{
  const box = { x: 0.2, y: 0.3, w: 0.1, h: 0.1 };
  const p = translateShape(box, 0.05, -0.05);
  ok("translate box", near(p.x, 0.25) && near(p.y, 0.25), J(p));
  // clamp: can't push past the page edge
  const edge = translateShape({ x: 0.95, y: 0.95, w: 0.1, h: 0.1 }, 0.5, 0.5);
  ok("translate clamps at edge", near(edge.x, 0.9) && near(edge.y, 0.9), J(edge));
}

// ---------- translate (line) - endpoints must move WITH the box ----------
{
  const line = { x: 0.1, y: 0.1, w: 0.3, h: 0.2, x1: 0.1, y1: 0.3, x2: 0.4, y2: 0.1 };
  const p = translateShape(line, 0.1, 0.1);
  ok("translate line endpoints follow",
     near(p.x1, 0.2) && near(p.y1, 0.4) && near(p.x2, 0.5) && near(p.y2, 0.2), J(p));
}

// ---------- nudge ----------
{
  const box = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
  const p = nudgeShape(box, 0.002, 0);
  ok("nudge box", near(p.x, 0.502), J(p));
  const freehand = { points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] };
  const pf = nudgeShape(freehand, 0.01, 0.01);
  ok("nudge freehand moves every point",
     near(pf.points[0].x, 0.11) && near(pf.points[1].x, 0.21), J(pf));
}

// ---------- resize ----------
{
  // Grow from the SE handle: x,y anchored, w/h grow.
  const box = { x: 0.2, y: 0.2, w: 0.2, h: 0.2 };
  const se = resizeShape(box, "se", 0.1, 0.1);
  ok("resize se grows w/h, keeps x/y",
     near(se.x, 0.2) && near(se.y, 0.2) && near(se.w, 0.3) && near(se.h, 0.3), J(se));
  // Resize from NW: x/y move, w/h shrink to compensate (opposite corner fixed).
  const nw = resizeShape(box, "nw", 0.05, 0.05);
  ok("resize nw moves x/y and shrinks w/h",
     near(nw.x, 0.25) && near(nw.y, 0.25) && near(nw.w, 0.15) && near(nw.h, 0.15), J(nw));
  // A diagonal line resized from se must keep its endpoints proportionally placed.
  const line = { x: 0, y: 0, w: 0.2, h: 0.2, x1: 0, y1: 0.2, x2: 0.2, y2: 0 }; // corner-to-corner
  const rl = resizeShape(line, "se", 0.2, 0.2); // box doubles to 0.4x0.4
  ok("resize line keeps endpoints proportional",
     near(rl.x1, 0) && near(rl.y1, 0.4) && near(rl.x2, 0.4) && near(rl.y2, 0), J(rl));
  // Zero-size shape must not divide by zero / NaN out.
  const degenerate = resizeShape({ x: 0.1, y: 0.1, w: 0, h: 0, x1: 0.1, y1: 0.1, x2: 0.1, y2: 0.1 }, "se", 0.1, 0.1);
  ok("resize degenerate shape no NaN",
     Number.isFinite(degenerate.w) && Number.isFinite(degenerate.h), J(degenerate));
}

// ---------- duplicate offset ----------
{
  const box = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
  const d = offsetForDuplicate(box);
  ok("duplicate offsets box", near(d.x, 0.525) && near(d.y, 0.525), J(d));
  const line = { x: 0.1, y: 0.1, w: 0.1, h: 0.1, x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 };
  const dl = offsetForDuplicate(line);
  ok("duplicate offsets line endpoints too",
     near(dl.x1, 0.125) && near(dl.x2, 0.225), J(dl));
  // clamp near page edge
  const edge = offsetForDuplicate({ x: 0.99, y: 0.99, w: 0.05, h: 0.05 });
  ok("duplicate clamps near edge", edge.x <= 0.96 && edge.y <= 0.96, J(edge));
}

// ---------- export transform: normalized -> PDF page space ----------
{
  const pageSize = { width: 600, height: 800 };
  // A point at editor-top-left (0,0) must land at PDF-top-left (0, height).
  const tl = toPdfPoint(0, 0, pageSize);
  ok("point top-left -> pdf y=height", near(tl.x, 0) && near(tl.y, 800), J(tl));
  // A box at (0.1,0.1,0.2,0.2) - its PDF y is measured from the BOTTOM of the box.
  const box = toPdfBox({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, pageSize);
  ok("box pdf coords",
     near(box.x, 60) && near(box.width, 120) && near(box.height, 160)
       && near(box.y, 800 - 80 - 160), J(box));
  // Line endpoints and box corners must agree: a line drawn along a box's
  // diagonal, exported, should land on that box's exported corners.
  const shapeBox = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  const shapeLine = { ...shapeBox, x1: 0.1, y1: 0.3, x2: 0.3, y2: 0.1 }; // bottom-left to top-right in editor space
  const pdfBox = toPdfBox(shapeBox, pageSize);
  const { start, end } = toPdfLineEndpoints(shapeLine, pageSize);
  ok("line endpoints align with box corners in PDF space",
     near(start.x, pdfBox.x) && near(start.y, pdfBox.y) &&
     near(end.x, pdfBox.x + pdfBox.width) && near(end.y, pdfBox.y + pdfBox.height),
     J({ start, end, pdfBox }));
  // Endpoint fallback when x1/y1/x2/y2 are missing (old data) - must use the box.
  const fallback = toPdfLineEndpoints({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, pageSize);
  ok("line endpoint fallback uses box corners",
     near(fallback.start.x, pdfBox.x) && near(fallback.end.x, pdfBox.x + pdfBox.width), J(fallback));
}

ok("clamp basic", clampNum(5, 0, 10) === 5 && clampNum(-1, 0, 10) === 0 && clampNum(99, 0, 10) === 10);

console.log(`\nSHAPE-GEOMETRY (JS): ${pass}/${pass + fail} passed`);
console.log("RESULT:", fail === 0 ? "PASS" : "FAIL");
process.exit(fail === 0 ? 0 : 1);
