// Sanitizes a client-supplied upload filename before it's used to build a
// filesystem path (path.join(tempDir, safeName(...))).
//
// Found via direct testing against the running server, not theory: a crafted
// multipart upload with filename=".." made path.join(tempDir, "..") resolve
// to the OS temp ROOT ITSELF (shared by every request), not just inside the
// per-request sandbox - path.basename("..") and path.basename(".") return
// the string unchanged (neither has a directory separator to strip), and "."
// is in the character allowlist, so the old sanitizer's basename+regex
// combination let both straight through. Confirmed impact: the crash was
// "only" an EISDIR 500 in this codebase's current shape, because the
// resolved path happened to collide with an existing directory - but the
// underlying issue is a genuine path-confinement bypass, not a cosmetic bug.
//
// Also closes two adjacent, confirmed-by-testing robustness gaps:
//  - Windows silently strips trailing dots/spaces from the final path
//    component at the filesystem API level, so "aaaaa.." gets written under
//    a name Node doesn't expect, and the engine subprocess 500s looking for
//    the literal string.
//  - An extremely long filename can exceed Windows' ~260-char path limit
//    once joined with the temp dir, silently failing the write.
const path = require("path");

function safeName(name, fallback) {
  let base = path.basename(String(name || fallback)).replace(/[^\w .()[\]-]/g, "_");
  if (base === "" || base === "." || base === "..") base = "";
  base = base.replace(/[. ]+$/, "");
  base = base || path.basename(String(fallback)).replace(/[^\w .()[\]-]/g, "_") || "file";
  if (base.length > 100) {
    const ext = path.extname(base).slice(0, 10);
    base = base.slice(0, 100 - ext.length) + ext;
  }
  return base;
}

module.exports = { safeName };
