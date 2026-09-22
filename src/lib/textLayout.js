// Text layout for the plain-text -> PDF converter (used for .txt/.csv/.md/.html
// and as the DOCX/XLSX/PPTX fallback path). Decoupled from pdf-lib so the word
// wrap and pagination logic can be unit-tested with a fake measurer instead of
// a real embedded font.
//
// `measure(text, size)` mirrors pdf-lib's `font.widthOfTextAtSize(text, size)`.

// Wrap one logical line to fit maxWidth. Unlike the original inline version,
// a single token WIDER than maxWidth (a long URL, an unbroken filename, a CSV
// cell with no spaces) is now hard-broken at the character level instead of
// being emitted as one over-width line that silently runs off the page edge.
export function wrapLine(text, measure, size, maxWidth) {
  const words = String(text).split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const lines = [];
  let current = "";

  const pushCurrent = () => { if (current) { lines.push(current); current = ""; } };

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    // candidate doesn't fit - flush what we had, then handle `word` itself.
    pushCurrent();
    if (measure(word, size) <= maxWidth) {
      current = word;
    } else {
      // The word alone is wider than the page. Hard-break it character by
      // character so every part of it still ends up on the page.
      let piece = "";
      for (const ch of word) {
        const next = piece + ch;
        if (measure(next, size) <= maxWidth || !piece) {
          piece = next;
        } else {
          lines.push(piece);
          piece = ch;
        }
      }
      current = piece;
    }
  }
  pushCurrent();
  return lines.length ? lines : [""];
}

// Paginate a full text body into pages of lines, given how many lines fit per
// page. Returns an array of pages, each an array of { text, blank } entries
// (blank = an extra gap after an empty source line, matching the old
// behavior of a small paragraph gap on blank input lines).
export function paginateText(text, { measure, size, maxWidth, linesPerPage }) {
  const rawLines = String(text || "").replace(/\t/g, "    ").split(/\r?\n/);
  const flat = [];
  for (const rawLine of rawLines) {
    wrapLine(rawLine, measure, size, maxWidth).forEach((line) => flat.push({ text: line }));
    if (!rawLine.trim()) flat.push({ text: "", gap: true });
  }
  const pages = [];
  let page = [];
  for (const entry of flat) {
    if (page.length >= linesPerPage) {
      pages.push(page);
      page = [];
    }
    page.push(entry);
  }
  if (page.length || pages.length === 0) pages.push(page);
  return pages;
}
