// Page operations for the editor: insert / delete / duplicate / move / reorder.
//
// One idea unifies them: describe the result as an ORDER array of source page
// indices (0-based), where the literal string "blank" means "a new empty page".
// From that single description we can both (a) rebuild the PDF bytes and (b)
// remap the overlay annotations so they follow their pages. Every op below is
// just a different order array, so they all share one tested code path - which
// is where the old inline closures kept subtly diverging.
//
// All page numbers in the public functions are 1-based (what the user sees).
// Tested in engine/tests/test_pageops_js.mjs with real pdf-lib.

import { PDFDocument } from "pdf-lib";

const DEFAULT_SIZE = [595.28, 841.89]; // A4 in points

// ---- order builders (pure) ------------------------------------------------ //
export function orderForInsert(count, afterPage) {
  // Insert exactly one blank AFTER `afterPage` (1-based). Clamped: <=0 => start,
  // >=count => end. Exactly one blank is added in every case.
  const at = Math.max(0, Math.min(afterPage, count));
  const order = [];
  if (at <= 0) order.push("blank");
  for (let i = 0; i < count; i += 1) {
    order.push(i);
    if (i + 1 === at) order.push("blank");
  }
  return order;
}

export function orderForDelete(count, page) {
  return range(count).filter((i) => i !== page - 1);
}

export function orderForDuplicate(count, page) {
  const order = [];
  for (let i = 0; i < count; i += 1) {
    order.push(i);
    if (i === page - 1) order.push(i); // second copy right after
  }
  return order;
}

export function orderForMove(count, from, to) {
  const order = range(count);
  const [moved] = order.splice(from - 1, 1);
  order.splice(clampIndex(to - 1, 0, order.length), 0, moved);
  return order;
}

function range(n) { return Array.from({ length: n }, (_, i) => i); }
function clampIndex(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---- annotation remap (pure) ---------------------------------------------- //
// Given the order array, move each annotation to its page's NEW position.
// Annotations on a dropped page vanish. For a duplicated page (its index
// appears twice) annotations are copied to every new position.
export function remapAnnotations(annotations, order, makeId) {
  const positionsByOld = new Map();
  order.forEach((src, newIdx) => {
    if (src === "blank") return;
    if (!positionsByOld.has(src)) positionsByOld.set(src, []);
    positionsByOld.get(src).push(newIdx + 1); // 1-based new page
  });
  const out = [];
  for (const ann of annotations) {
    const targets = positionsByOld.get(ann.page - 1);
    if (!targets || targets.length === 0) continue; // page was deleted
    targets.forEach((newPage, k) => {
      out.push(k === 0 ? { ...ann, page: newPage }
                       : { ...ann, page: newPage, id: makeId ? makeId() : ann.id });
    });
  }
  return out;
}

// ---- byte rebuild (async, pdf-lib) ---------------------------------------- //
export async function applyOrder(pdfBytes, order, { blankSize } = {}) {
  // Deliberately NOT `ignoreEncryption: true`. pdf-lib can't actually decrypt
  // an encrypted PDF - that flag just lets `load` succeed while the content
  // streams stay encrypted, so copyPages "succeeds" too, silently producing
  // pages that are 100% corrupted garbage (confirmed: every page blank,
  // MuPDF errors on all of them) - for an OWNER-password-only PDF, which
  // opens with zero prompt in this app (or any normal viewer), so the user
  // has no way to know their document is "encrypted" at all until an insert/
  // delete/duplicate/move/reorder silently wrecks the whole file. Loading
  // without the flag throws immediately for any encrypted file instead, so
  // callers can surface a clear "use Unlock PDF first" message.
  let src;
  try {
    src = await PDFDocument.load(pdfBytes);
  } catch (error) {
    if (/encrypted/i.test(error.message || "")) {
      throw new Error("This PDF has security restrictions from its owner. Use Unlock PDF first, then retry this action.");
    }
    throw error;
  }
  const out = await PDFDocument.create();
  const srcCount = src.getPageCount();
  const realIdx = order.filter((o) => o !== "blank");
  const copied = realIdx.length
    ? await out.copyPages(src, realIdx.map((i) => clampIndex(i, 0, srcCount - 1)))
    : [];
  let ci = 0;
  const size = blankSize || DEFAULT_SIZE;
  for (const o of order) {
    if (o === "blank") out.addPage(size);
    else { out.addPage(copied[ci]); ci += 1; }
  }
  return out.save();
}

// ---- high-level convenience (bytes + remapped annotations) ---------------- //
export async function insertBlank(pdfBytes, annotations, afterPage, count, blankSize) {
  const order = orderForInsert(count, afterPage);
  const bytes = await applyOrder(pdfBytes, order, { blankSize });
  return { bytes, annotations: remapAnnotations(annotations, order) };
}
export async function deletePage(pdfBytes, annotations, page, count) {
  const order = orderForDelete(count, page);
  // Deleting the only page produces an EMPTY order array. pdf-lib's default
  // `save()` behavior then silently inserts its own blank page to avoid a
  // zero-page file (`addDefaultPage`, on by default) - so this doesn't throw
  // or error, it just quietly replaces the document with one blank page and
  // reports success. Confirmed directly: page count comes back as 1, but
  // all original content is gone. The App.jsx caller already guards this
  // case in the UI, but the guard belongs here too - any other caller of
  // this shared function would otherwise hit the same silent data loss the
  // server's equivalent (`cmd_delete` in engine.py) already refuses.
  if (order.length === 0) {
    throw new Error("Can't delete the only page in the document.");
  }
  const bytes = await applyOrder(pdfBytes, order);
  return { bytes, annotations: remapAnnotations(annotations, order) };
}
export async function duplicatePage(pdfBytes, annotations, page, count, makeId) {
  const order = orderForDuplicate(count, page);
  const bytes = await applyOrder(pdfBytes, order);
  return { bytes, annotations: remapAnnotations(annotations, order, makeId) };
}
export async function movePage(pdfBytes, annotations, from, to, count) {
  const order = orderForMove(count, from, to);
  const bytes = await applyOrder(pdfBytes, order);
  return { bytes, annotations: remapAnnotations(annotations, order) };
}
