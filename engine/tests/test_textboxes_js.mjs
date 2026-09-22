// Unit tests for src/lib/textBoxes.js - the coordinate math behind
// Edit-existing-text, Make-editable, and OCR box placement.
//   node engine/tests/test_textboxes_js.mjs
import {
  normalizedBoxFromTransform, ocrBoxToNormalized, findBoxAtPoint, clampNum,
} from "../../src/lib/textBoxes.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  cond ? pass++ : fail++;
}
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// ---------- OCR bbox -> normalized ----------
{
  // A word 200px wide, 40px tall at (100,80) on a 1000x1400 canvas; page 800pt tall.
  const box = ocrBoxToNormalized(
    { text: "Hello", confidence: 92, bbox: { x0: 100, y0: 80, x1: 300, y1: 120 } },
    1000, 1400, { width: 600, height: 800 });
  ok("ocr x", near(box.x, 0.1), box.x);
  ok("ocr y", near(box.y, 80 / 1400), box.y);
  ok("ocr w", near(box.w, 0.2), box.w);
  ok("ocr text trimmed", box.str === "Hello");
  ok("ocr confidence", box.confidence === 92);
  // fontSize = (40/1400)*800*0.86 ~= 19.66 -> round 20
  ok("ocr fontSize", box.fontSize === 20, String(box.fontSize));
}
{
  // Alternate bbox convention {left,top,width,height} must give the same result.
  const a = ocrBoxToNormalized(
    { text: "X", bbox: { x0: 50, y0: 60, x1: 150, y1: 100 } }, 500, 500, { height: 500 });
  const b = ocrBoxToNormalized(
    { text: "X", bbox: { left: 50, top: 60, width: 100, height: 40 } }, 500, 500, { height: 500 });
  ok("ocr both bbox formats equal",
     near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && a.fontSize === b.fontSize,
     JSON.stringify([a, b]));
}
{
  // Degenerate zero-size box must not crash and must clamp to minimums.
  const box = ocrBoxToNormalized({ text: "z", bbox: { x0: 0, y0: 0, x1: 0, y1: 0 } }, 800, 600, { height: 600 });
  ok("ocr zero-box clamps", box.w >= 0.01 && box.h >= 0.01, JSON.stringify(box));
}

// ---------- pdf.js transform -> normalized ----------
{
  // scale-12 text at baseline (60, 200) on a 600x800 viewport.
  const t = [12, 0, 0, 12, 60, 200]; // a,b,c,d,e,f
  const box = normalizedBoxFromTransform(t, { width: 40, str: "Hi" }, { width: 600, height: 800, scale: 1 });
  ok("tx x", near(box.x, 0.1), box.x);
  // y = (200 - 12) / 800
  ok("tx y top-of-glyph", near(box.y, (200 - 12) / 800), box.y);
  ok("tx fontSize", box.fontSize === 12, String(box.fontSize));
}

// ---------- click hit-test ----------
{
  const items = [
    { id: "a", x: 0.10, y: 0.10, w: 0.20, h: 0.05 },
    { id: "b", x: 0.12, y: 0.11, w: 0.10, h: 0.03 }, // overlaps a, smaller/nearer
  ];
  const hitB = findBoxAtPoint(items, { x: 0.17, y: 0.125 });
  ok("hit nearest-center resolves overlap", hitB && hitB.id === "b", hitB && hitB.id);
  const miss = findBoxAtPoint(items, { x: 0.9, y: 0.9 });
  ok("hit miss returns null", miss === null);
  const edge = findBoxAtPoint(items, { x: 0.10 - 0.003, y: 0.10 }); // within tolerance
  ok("hit tolerance edge", edge && edge.id === "a", edge && edge.id);
}

// ---------- clamp guard ----------
ok("clamp NaN -> min", clampNum(NaN, 3, 9) === 3);
ok("clamp over -> max", clampNum(99, 3, 9) === 9);

console.log(`\nTEXT-BOXES (JS): ${pass}/${pass + fail} passed`);
console.log("RESULT:", fail === 0 ? "PASS" : "FAIL");
process.exit(fail === 0 ? 0 : 1);
