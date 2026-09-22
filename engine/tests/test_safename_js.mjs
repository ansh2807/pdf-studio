// Unit tests for engine/safeName.cjs - the upload-filename sanitizer.
// Locks in a real, confirmed-by-live-testing path-confinement bypass: a
// filename of exactly ".." or "." used to survive sanitization unchanged and
// resolve OUTSIDE the sandboxed per-request temp directory when joined with
// it (path.join(tempDir, "..") === the shared OS temp root). Also locks in
// two related robustness gaps confirmed the same way (trailing dots getting
// silently stripped by Windows, and overlong names exceeding MAX_PATH).
//   node engine/tests/test_safename_js.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const path = require("path");
const { safeName } = require("../safeName.cjs");

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  cond ? pass++ : fail++;
}

// The actual exploit condition: does path.join(tempDir, result) stay INSIDE
// tempDir? This is the real invariant that matters, not just "what string
// comes out" - so assert it the same way the vulnerability was found.
function staysInside(tempDir, result) {
  const resolved = path.resolve(path.join(tempDir, result));
  const base = path.resolve(tempDir);
  return resolved === base || resolved.startsWith(base + path.sep);
}

const TEMP = path.join("C:", "Users", "x", "AppData", "Local", "Temp", "local-pdf-engine-ABC123");

// ---------- THE CONFIRMED EXPLOIT ----------
for (const evil of ["..", "."]) {
  const result = safeName(evil, "fallback.pdf");
  ok(`filename=${JSON.stringify(evil)} does not escape the temp dir`,
     staysInside(TEMP, result), `-> ${JSON.stringify(result)}`);
  ok(`filename=${JSON.stringify(evil)} does not return "." or ".." literally`,
     result !== "." && result !== "..", result);
}

// ---------- directory traversal via separators (basename should strip these) ----------
for (const evil of ["../../evil.pdf", "..\\..\\evil.pdf", "/etc/passwd", "a/../../b.pdf"]) {
  const result = safeName(evil, "fallback.pdf");
  ok(`filename=${JSON.stringify(evil)} does not escape the temp dir`,
     staysInside(TEMP, result), `-> ${JSON.stringify(result)}`);
}

// ---------- trailing dots (Windows filesystem quirk) ----------
{
  const r1 = safeName("aaaaa..", "fallback.pdf");
  ok("trailing dots are stripped", !r1.endsWith("."), r1);
  ok("content before the trailing dots is preserved", r1.startsWith("aaaaa"), r1);
}
{
  const r2 = safeName("...", "fallback.pdf");
  ok("all-dots name falls back rather than producing an empty/dot name",
     r2 !== "" && r2 !== "." && r2 !== ".." && !r2.endsWith("."), r2);
}

// ---------- overlong names (MAX_PATH) ----------
{
  const long = "a".repeat(500) + ".pdf";
  const result = safeName(long, "fallback.pdf");
  ok("overlong name is truncated", result.length <= 100, result.length);
  ok("extension is preserved after truncation", result.endsWith(".pdf"), result);
}

// ---------- normal, legitimate names pass through basically unchanged ----------
for (const good of ["report.pdf", "My Document (2024).pdf", "invoice-123.pdf", "résumé.pdf"]) {
  const result = safeName(good, "fallback.pdf");
  ok(`normal filename ${JSON.stringify(good)} is preserved (allowing for char-class stripping)`,
     result.length > 0 && staysInside(TEMP, result), result);
}

// ---------- fallback behavior ----------
ok("empty name uses the fallback", safeName("", "fallback.pdf") === "fallback.pdf");
ok("null name uses the fallback", safeName(null, "fallback.pdf") === "fallback.pdf");
ok("undefined name uses the fallback", safeName(undefined, "fallback.pdf") === "fallback.pdf");

console.log(`\nSAFE-NAME (JS): ${pass}/${pass + fail} passed`);
console.log("RESULT:", fail === 0 ? "PASS" : "FAIL");
process.exit(fail === 0 ? 0 : 1);
