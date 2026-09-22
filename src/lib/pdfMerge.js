// Combine several PDFs (as byte arrays) into one, preserving page order.
//
// Extracted so both "Open several files" and the "Merge PDF" button share one
// well-tested code path, and so it can be unit-tested in Node with real pdf-lib
// (the browser closures in App.jsx can't be). Returns the merged PDF bytes.

import { PDFDocument } from "pdf-lib";

/**
 * @param {Array<Uint8Array|ArrayBuffer>} sources  PDFs to concatenate, in order.
 * @param {Array<string>} [names]  Optional display name per source, for error
 *   messages (e.g. the original filename). Missing entries fall back to
 *   "file N".
 * @returns {Promise<Uint8Array>} merged PDF bytes.
 */
export async function mergePdfBytes(sources, names = []) {
  const list = (sources || []).filter(Boolean);
  if (list.length === 0) throw new Error("No PDFs to merge");
  if (list.length === 1) {
    // Still normalize through pdf-lib so a single item returns clean bytes.
    const only = await PDFDocument.load(list[0]);
    return only.save();
  }
  const out = await PDFDocument.create();
  for (let i = 0; i < list.length; i += 1) {
    const label = names[i] || `file ${i + 1}`;
    // The whole per-file step (load AND copyPages) is guarded, not just
    // load: a structurally-broken file can parse "successfully" enough for
    // `load` to return an object, then blow up with a raw, unhelpful pdf-lib
    // internal error (e.g. "Cannot read properties of undefined (reading
    // 'Pages')") the moment copyPages actually walks its page tree -
    // confirmed with a truncated/garbage input. Catching only around load
    // let that raw error leak straight to the user.
    try {
      // Deliberately NOT `ignoreEncryption: true`: pdf-lib can't actually
      // decrypt an encrypted PDF, so that flag just lets `load` succeed
      // while leaving the content streams still encrypted - `copyPages`
      // then "succeeds" too, silently copying pages whose content is
      // garbage (confirmed: renders blank, MuPDF logs a content-stream
      // syntax error on every page copied that way). Loading without the
      // flag throws immediately for an encrypted file instead, which we
      // turn into an honest, specific error below.
      const src = await PDFDocument.load(list[i]);
      const copied = await out.copyPages(src, src.getPageIndices());
      copied.forEach((p) => out.addPage(p));
    } catch (error) {
      if (/encrypted/i.test(error.message || "")) {
        throw new Error(`"${label}" is password-protected, so its pages can't be merged safely. Remove the password first with Unlock PDF, then try again.`);
      }
      throw new Error(`"${label}" could not be read - it may be corrupted or not a valid PDF.`);
    }
  }
  return out.save();
}
