// Page-range parsing for the editor's Extract / Split / Remove tools.
//
// Extracted from App.jsx so it can be unit-tested (browsers can't easily test
// inline component closures). Semantics deliberately match the server engine's
// parse_page_spec (engine.py) so a user typing "1-3,5" gets the SAME pages
// whether the browser or the engine does the work.
//
// Supported: "1-3,5,8"  •  open-ended end "3-" (3..last)  •  open-ended start
// "-2" (1..2)  •  reversed "5-1" (normalized)  •  junk tokens ignored.
// Returns SORTED, de-duplicated 0-based indices (what the pdf-lib callers want).

export function clampInt(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function parsePageRange(input, max) {
  const pages = new Set();
  if (!input || max < 1) return [];
  for (const rawPart of String(input).split(",")) {
    const part = rawPart.trim();
    if (!part) continue;

    if (part.includes("-")) {
      const [aStr, bStr] = part.split("-").map((v) => v.trim());
      // Empty side = open-ended: "3-" -> 3..max, "-2" -> 1..2. This is the bug
      // the old inline parser got wrong (it read "3-" as pages 1..3).
      const aNum = aStr === "" ? 1 : Number(aStr);
      const bNum = bStr === "" ? max : Number(bStr);
      if (!Number.isFinite(aNum) || !Number.isFinite(bNum)) continue;
      let start = clampInt(aNum, 1, max);
      let end = clampInt(bNum, 1, max);
      if (start > end) [start, end] = [end, start];
      for (let p = start; p <= end; p += 1) pages.add(p - 1);
    } else {
      const n = Number(part);
      if (!Number.isFinite(n)) continue;
      if (n >= 1 && n <= max) pages.add(Math.round(n) - 1);
    }
  }
  return [...pages].sort((a, b) => a - b);
}
