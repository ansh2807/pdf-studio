// Unit test for src/lib/pdfMerge.js using real pdf-lib in Node.
// Identity trick: each source page gets a UNIQUE width (100 + 10*marker), so
// after merging we read page widths back with pdf-lib and decode the exact
// page identity and ORDER - no text extraction / pdfjs needed.
//   node engine/tests/test_pdfmerge_js.mjs
import { PDFDocument } from "pdf-lib";
import { mergePdfBytes } from "../../src/lib/pdfMerge.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  cond ? pass++ : fail++;
}

const W = (m) => 100 + 10 * m;             // marker -> width
const unW = (w) => Math.round((w - 100) / 10); // width -> marker

async function makePdf(markers) {
  const doc = await PDFDocument.create();
  for (const m of markers) doc.addPage([W(m), 400]);
  return doc.save();
}

async function markersOf(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => unW(p.getWidth()));
}

async function main() {
  const a = await makePdf([1, 2]);
  const b = await makePdf([3, 4, 5]);
  const c = await makePdf([6]);

  const merged = await mergePdfBytes([a, b, c]);
  ok("merge order 1..6",
     JSON.stringify(await markersOf(merged)) === JSON.stringify([1, 2, 3, 4, 5, 6]),
     JSON.stringify(await markersOf(merged)));

  const single = await mergePdfBytes([a]);
  ok("single normalizes",
     JSON.stringify(await markersOf(single)) === JSON.stringify([1, 2]));

  let threw = false;
  try { await mergePdfBytes([]); } catch { threw = true; }
  ok("empty rejected", threw);

  const reversed = await mergePdfBytes([c, b, a]);
  ok("order respects input",
     JSON.stringify(await markersOf(reversed)) === JSON.stringify([6, 3, 4, 5, 1, 2]),
     JSON.stringify(await markersOf(reversed)));

  console.log(`\nPDF-MERGE (JS): ${pass}/${pass + fail} passed`);
  console.log("RESULT:", fail === 0 ? "PASS" : "FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
