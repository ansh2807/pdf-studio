// Unit tests for src/lib/textLayout.js - the word-wrap/pagination behind the
// plain-text -> PDF converter (txt/csv/md/html and the docx/xlsx/pptx fallback).
//   node engine/tests/test_textlayout_js.mjs
import { wrapLine, paginateText } from "../../src/lib/textLayout.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  cond ? pass++ : fail++;
}

// Fake measurer: monospace-ish, width = 6 units per character at size 1.
const measure = (text, size) => text.length * 6 * (size / 11);

// ---------- wrapLine ----------
{
  const lines = wrapLine("the quick brown fox jumps over the lazy dog", measure, 11, 60);
  ok("wraps into multiple lines within width",
     lines.every((l) => measure(l, 11) <= 60) && lines.join(" ").replace(/ +/g, " ")
       === "the quick brown fox jumps over the lazy dog",
     JSON.stringify(lines));
}
{
  // Exact-fit boundary: candidate width exactly equals maxWidth should still fit.
  const w = measure("ab cd", 11); // = 30
  const lines = wrapLine("ab cd", measure, 11, w);
  ok("exact-fit boundary keeps one line", lines.length === 1 && lines[0] === "ab cd", JSON.stringify(lines));
}
{
  // THE BUG THIS FIXES: a single token wider than maxWidth must be hard-broken,
  // not emitted whole (which would run off the page in the old code).
  const longUrl = "https://example.com/" + "a".repeat(40);
  const lines = wrapLine(longUrl, measure, 11, 60);
  const allFit = lines.every((l) => measure(l, 11) <= 60 + 1e-9);
  const reassembled = lines.join("");
  ok("long unbroken token hard-broken to fit", allFit, JSON.stringify(lines.map((l) => l.length)));
  ok("hard-break preserves all characters", reassembled === longUrl, `${reassembled.length} vs ${longUrl.length}`);
}
{
  const lines = wrapLine("", measure, 11, 200);
  ok("empty line yields one empty entry", lines.length === 1 && lines[0] === "", JSON.stringify(lines));
}
{
  // Mixed: a normal word followed by an oversized token followed by a normal word.
  const text = "start " + "x".repeat(30) + " end";
  const lines = wrapLine(text, measure, 11, 60);
  const allFit = lines.every((l) => measure(l, 11) <= 60 + 1e-9);
  ok("mixed normal+oversized+normal all fit", allFit, JSON.stringify(lines));
  ok("mixed reassembles losslessly (ignoring the wrap spaces)",
     lines.join("").replace(/^start/, "start ").length >= text.replace(/\s/g, "").length,
     "");
}

// ---------- paginateText ----------
{
  const body = Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n");
  const pages = paginateText(body, { measure, size: 11, maxWidth: 500, linesPerPage: 10 });
  ok("paginates into ceil(25/10)=3 pages", pages.length === 3, String(pages.length));
  const total = pages.reduce((n, p) => n + p.length, 0);
  ok("no lines dropped across pages", total === 25, String(total));
  ok("first page starts with line 0", pages[0][0].text === "line 0", pages[0][0].text);
  ok("last page ends with line 24", pages.at(-1).at(-1).text === "line 24", pages.at(-1).at(-1).text);
}
{
  // Blank source lines add a paragraph-gap marker (matches old `y -= 5` behavior).
  const pages = paginateText("a\n\nb", { measure, size: 11, maxWidth: 500, linesPerPage: 100 });
  const gapCount = pages[0].filter((e) => e.gap).length;
  ok("blank line produces a gap entry", gapCount === 1, JSON.stringify(pages[0]));
}
{
  const pages = paginateText("", { measure, size: 11, maxWidth: 500, linesPerPage: 10 });
  ok("empty text still yields one page (title-only doc)", pages.length === 1, String(pages.length));
}

console.log(`\nTEXT-LAYOUT (JS): ${pass}/${pass + fail} passed`);
console.log("RESULT:", fail === 0 ? "PASS" : "FAIL");
process.exit(fail === 0 ? 0 : 1);
