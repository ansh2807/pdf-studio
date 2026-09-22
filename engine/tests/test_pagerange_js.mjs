// Unit test for the browser page-range parser (src/lib/pageRange.js).
// Run:  node engine/tests/test_pagerange_js.mjs
import { parsePageRange } from "../../src/lib/pageRange.js";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  got=${g}${ok ? "" : " want=" + w}`);
  ok ? pass++ : fail++;
}

// 0-based indices, sorted, de-duplicated.
eq("simple list",        parsePageRange("1,3,5", 10), [0, 2, 4]);
eq("range",              parsePageRange("1-3", 10), [0, 1, 2]);
eq("mixed",              parsePageRange("1-3,5", 10), [0, 1, 2, 4]);
eq("dedup + sort",       parsePageRange("5,1-2,2", 10), [0, 1, 4]);
// The bug this fix targets: open-ended end must mean N..last, not 1..N.
eq("open-ended end 3-",  parsePageRange("3-", 5), [2, 3, 4]);
eq("open-ended start -2",parsePageRange("-2", 5), [0, 1]);
eq("reversed 5-1",       parsePageRange("5-1", 5), [0, 1, 2, 3, 4]);
// Robustness: out-of-range and junk ignored.
eq("clamp over max",     parsePageRange("8-99", 10), [7, 8, 9]);
eq("junk ignored",       parsePageRange("0,foo,3,,", 5), [2]);
eq("empty input",        parsePageRange("", 5), []);
eq("whitespace",         parsePageRange(" 2 - 4 ", 10), [1, 2, 3]);

console.log(`\nPAGE-RANGE (JS): ${pass}/${pass + fail} passed`);
console.log("RESULT:", fail === 0 ? "PASS" : "FAIL");
process.exit(fail === 0 ? 0 : 1);
