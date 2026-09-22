// Unit tests for src/lib/pageOps.js (insert/delete/duplicate/move) with real
// pdf-lib. Page identity = unique page width (100 + 10*marker), so we can read
// the resulting order back and also confirm annotation remapping follows pages.
//   node engine/tests/test_pageops_js.mjs
import { PDFDocument } from "pdf-lib";
import {
  orderForInsert, orderForDelete, orderForDuplicate, orderForMove,
  remapAnnotations, applyOrder,
} from "../../src/lib/pageOps.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  cond ? pass++ : fail++;
}
const J = (x) => JSON.stringify(x);

const W = (m) => 100 + 10 * m;
const unW = (w) => Math.round((w - 100) / 10);

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
  // ---------- order builders (pure) ----------
  ok("orderInsert middle", J(orderForInsert(3, 1)) === J([0, "blank", 1, 2]));
  ok("orderInsert start",  J(orderForInsert(3, 0)) === J(["blank", 0, 1, 2]));
  ok("orderInsert end",    J(orderForInsert(3, 3)) === J([0, 1, 2, "blank"]));
  ok("orderInsert clamp",  J(orderForInsert(3, 9)) === J([0, 1, 2, "blank"]));
  ok("orderDelete",        J(orderForDelete(4, 2)) === J([0, 2, 3]));
  ok("orderDuplicate",     J(orderForDuplicate(3, 2)) === J([0, 1, 1, 2]));
  ok("orderMove down",     J(orderForMove(4, 1, 3)) === J([1, 2, 0, 3]));
  ok("orderMove up",       J(orderForMove(4, 4, 1)) === J([3, 0, 1, 2]));

  // ---------- annotation remap (pure) ----------
  const anns = [
    { id: "a", page: 1, t: "x" },
    { id: "b", page: 2, t: "y" },
    { id: "c", page: 3, t: "z" },
  ];
  // delete page 2 -> b vanishes, c moves to page 2
  let r = remapAnnotations(anns, orderForDelete(3, 2));
  ok("remap delete drops+shifts",
     J(r) === J([{ id: "a", page: 1, t: "x" }, { id: "c", page: 2, t: "z" }]), J(r));
  // insert blank after page1 -> b,c shift down by 1; a stays
  r = remapAnnotations(anns, orderForInsert(3, 1));
  ok("remap insert shifts",
     J(r.map((x) => x.page)) === J([1, 3, 4]), J(r.map((x) => x.page)));
  // duplicate page 1 -> annotation a copied to page 2 with a NEW id; b,c shift
  let counter = 0;
  r = remapAnnotations(anns, orderForDuplicate(3, 1), () => `new${++counter}`);
  const aCopies = r.filter((x) => x.t === "x");
  ok("remap duplicate copies annotation",
     aCopies.length === 2 && aCopies[0].page === 1 && aCopies[1].page === 2
       && aCopies[1].id !== "a", J(r.map((x) => [x.id, x.page])));
  // move page 1 -> 3: a follows to page 3
  r = remapAnnotations(anns, orderForMove(3, 1, 3));
  const aMoved = r.find((x) => x.t === "x");
  ok("remap move follows page", aMoved.page === 3, J(r.map((x) => [x.t, x.page])));

  // ---------- byte rebuild matches order (integration with pdf-lib) ----------
  const src = await makePdf([1, 2, 3, 4]);
  ok("bytes: insert blank after 2",
     J(await markersOf(await applyOrder(src, orderForInsert(4, 2), { blankSize: [W(0), 400] })))
       === J([1, 2, 0, 3, 4]), "0 = the inserted blank page");
  ok("bytes: delete page 3",
     J(await markersOf(await applyOrder(src, orderForDelete(4, 3)))) === J([1, 2, 4]));
  ok("bytes: duplicate page 2",
     J(await markersOf(await applyOrder(src, orderForDuplicate(4, 2)))) === J([1, 2, 2, 3, 4]));
  ok("bytes: move page 1 -> 4",
     J(await markersOf(await applyOrder(src, orderForMove(4, 1, 4)))) === J([2, 3, 4, 1]));

  console.log(`\nPAGE-OPS (JS): ${pass}/${pass + fail} passed`);
  console.log("RESULT:", fail === 0 ? "PASS" : "FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
