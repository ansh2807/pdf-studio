import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  CaseSensitive,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleSlash,
  Copy,
  Crop,
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowUpRight,
  Bold,
  Check,
  Eraser,
  FileInput,
  FileOutput,
  FilePlus2,
  Hand,
  Highlighter,
  ImagePlus,
  Italic,
  KeyRound,
  Layers,
  LineChart,
  MessageSquare,
  MousePointer2,
  Palette,
  PenLine,
  RectangleHorizontal,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  ShieldCheck,
  Signature,
  Stamp,
  Scissors,
  Trash2,
  Underline,
  Upload,
  Wand2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";
import JSZip from "jszip";
import PhotoStudio from "./PhotoStudio.jsx";
import PaperShell from "./PaperShell.jsx";
import * as paperSound from "./paperSound.js";
import { callAi, inferProvider, listModels } from "./aiClient.js";
import { parsePageRange } from "./lib/pageRange.js";
import { mergePdfBytes } from "./lib/pdfMerge.js";
import { insertBlank as opsInsertBlank, deletePage as opsDeletePage, duplicatePage as opsDuplicatePage, movePage as opsMovePage } from "./lib/pageOps.js";
import { normalizedBoxFromTransform, ocrBoxToNormalized, findBoxAtPoint } from "./lib/textBoxes.js";
import { translateShape, resizeShape, nudgeShape, offsetForDuplicate, toPdfPoint, toPdfBox, toPdfLineEndpoints } from "./lib/shapeGeometry.js";
import { wrapLine } from "./lib/textLayout.js";
import { smoothPoints, smoothPathD } from "./lib/smoothPath.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// In dev, the engine runs on its own port (5174) beside Vite. In a production
// build the Node server serves this front-end AND the engine on one origin, so
// requests go to same-origin relative paths. Override with VITE_ENGINE_BASE.
const NATIVE_ENGINE_BASE =
  import.meta.env.VITE_ENGINE_BASE ?? (import.meta.env.DEV ? "http://127.0.0.1:5174" : "");

const TOOLS = [
  { id: "select", label: "Select", icon: MousePointer2 },
  { id: "pan", label: "Pan", icon: Hand },
  { id: "text", label: "Text", icon: CaseSensitive },
  { id: "editText", label: "Edit existing text", icon: Search },
  { id: "highlight", label: "Highlight", icon: Highlighter },
  { id: "rectangle", label: "Box", icon: RectangleHorizontal },
  { id: "ellipse", label: "Ellipse", icon: Circle },
  { id: "line", label: "Line", icon: LineChart },
  { id: "arrow", label: "Arrow", icon: ArrowUpRight },
  { id: "note", label: "Note", icon: MessageSquare },
  { id: "check", label: "Check", icon: Check },
  { id: "redact", label: "Redact", icon: CircleSlash },
  { id: "pen", label: "Pen", icon: PenLine },
  { id: "signature", label: "Sign", icon: Signature },
  { id: "stamp", label: "Stamp", icon: Stamp },
  { id: "image", label: "Image", icon: ImagePlus },
  { id: "eraser", label: "Erase", icon: Eraser },
];

const SWATCHES = ["#111827", "#ef4444", "#2563eb", "#16a34a", "#ca8a04", "#9333ea", "#ffffff", "#facc15"];
const PAPER = { width: 612, height: 792 };
const FONT_OPTIONS = [
  { id: "helvetica", label: "Helvetica", css: "Arial, Helvetica, sans-serif", pdfBase: "helvetica" },
  { id: "arial", label: "Arial", css: "Arial, Helvetica, sans-serif", pdfBase: "helvetica" },
  { id: "aptos", label: "Aptos UI", css: "Aptos, Segoe UI, sans-serif", pdfBase: "helvetica" },
  { id: "verdana", label: "Verdana", css: "Verdana, Geneva, sans-serif", pdfBase: "helvetica" },
  { id: "trebuchet", label: "Trebuchet MS", css: "Trebuchet MS, Arial, sans-serif", pdfBase: "helvetica" },
  { id: "impact", label: "Impact", css: "Impact, Haettenschweiler, sans-serif", pdfBase: "helvetica" },
  { id: "times", label: "Times New Roman", css: "Times New Roman, Times, serif", pdfBase: "times" },
  { id: "georgia", label: "Georgia", css: "Georgia, Times New Roman, serif", pdfBase: "times" },
  { id: "garamond", label: "Garamond", css: "Garamond, Georgia, serif", pdfBase: "times" },
  { id: "palatino", label: "Palatino", css: "Palatino Linotype, Palatino, serif", pdfBase: "times" },
  { id: "courier", label: "Courier New", css: "Courier New, Courier, monospace", pdfBase: "courier" },
  { id: "consolas", label: "Consolas", css: "Consolas, Courier New, monospace", pdfBase: "courier" },
  { id: "monaco", label: "Monaco", css: "Monaco, Consolas, monospace", pdfBase: "courier" },
  { id: "comic", label: "Comic Sans", css: "Comic Sans MS, Comic Sans, cursive", pdfBase: "helvetica" },
];

// OCR was hardcoded to English only, silently producing garbage on any
// non-English scan. Tesseract.js language codes; combos (e.g. "eng+hin") are
// real, common cases - many scanned Indian government forms mix English and
// a regional script on the same page, for one example.
const OCR_LANGUAGES = [
  { code: "eng", label: "English" },
  { code: "hin", label: "Hindi" },
  { code: "eng+hin", label: "English + Hindi" },
  { code: "spa", label: "Spanish" },
  { code: "fra", label: "French" },
  { code: "deu", label: "German" },
  { code: "por", label: "Portuguese" },
  { code: "ita", label: "Italian" },
  { code: "rus", label: "Russian" },
  { code: "ara", label: "Arabic" },
  { code: "chi_sim", label: "Chinese (Simplified)" },
  { code: "chi_tra", label: "Chinese (Traditional)" },
  { code: "jpn", label: "Japanese" },
  { code: "kor", label: "Korean" },
  { code: "ben", label: "Bengali" },
  { code: "tam", label: "Tamil" },
  { code: "tel", label: "Telugu" },
  { code: "mar", label: "Marathi" },
  { code: "guj", label: "Gujarati" },
  { code: "urd", label: "Urdu" },
  { code: "eng+urd", label: "English + Urdu" },
  { code: "vie", label: "Vietnamese" },
  { code: "tha", label: "Thai" },
  { code: "nld", label: "Dutch" },
  { code: "pol", label: "Polish" },
  { code: "tur", label: "Turkish" },
];

const TOOL_CENTER = [
  {
    title: "Organize PDF",
    tools: [
      ["merge", "Merge PDF"],
      ["split", "Split PDF"],
      ["remove", "Remove pages"],
      ["extract", "Extract pages"],
      ["organize", "Organize PDF"],
      ["scan", "Scan to PDF"],
    ],
  },
  {
    title: "Optimize PDF",
    tools: [
      ["compress", "Compress PDF"],
      ["compressStrong", "Compress (strong)"],
      ["repair", "Repair PDF"],
      ["ocr", "OCR PDF"],
    ],
  },
  {
    title: "Convert to PDF",
    tools: [
      ["jpgToPdf", "JPG to PDF"],
      ["wordToPdf", "WORD to PDF"],
      ["pptToPdf", "POWERPOINT to PDF"],
      ["excelToPdf", "EXCEL to PDF"],
      ["htmlToPdf", "HTML to PDF"],
    ],
  },
  {
    title: "Convert from PDF",
    tools: [
      ["pdfToJpg", "PDF to JPG"],
      ["pdfToWord", "PDF to WORD"],
      ["pdfToPpt", "PDF to POWERPOINT"],
      ["pdfToExcel", "PDF to EXCEL"],
      ["pdfToPdfA", "PDF to PDF/A"],
    ],
  },
  {
    title: "Edit PDF",
    tools: [
      ["rotate", "Rotate PDF"],
      ["pageNumbers", "Add page numbers"],
      ["watermark", "Add watermark"],
      ["crop", "Crop PDF"],
      ["edit", "Edit PDF"],
      ["forms", "PDF Forms"],
    ],
  },
  {
    title: "PDF Security",
    tools: [
      ["unlock", "Unlock PDF"],
      ["crackPassword", "Recover PDF password"],
      ["protect", "Protect PDF"],
      ["removeWatermark", "Remove watermark"],
      ["sign", "Sign PDF"],
      ["redact", "Redact PDF"],
      ["compare", "Compare PDF"],
    ],
  },
  {
    title: "PDF Intelligence",
    tools: [
      ["summarize", "AI Summarizer"],
      ["translate", "Translate PDF"],
    ],
  },
  {
    title: "Photo Studio",
    tools: [
      ["photoStudio", "Photo crop & resize"],
      ["passportPhoto", "Passport size photo"],
      ["govtPhoto", "Govt upload size (KB)"],
    ],
  },
];

// Maps each Tool Center action to the engine feature that powers it (if any).
// Tools not listed here are pure browser tools and always work offline.
const TOOL_ENGINE_FEATURE = {
  compress: "compress",
  compressStrong: "compress",
  repair: "repair",
  pdfToJpg: "pdfToImages",
  pdfToWord: "pdfToWord",
  pdfToPpt: "pdfToPpt",
  pdfToExcel: "pdfToExcel",
  pdfToPdfA: "pdfa",
  wordToPdf: "wordToPdf",
  excelToPdf: "excelToPdf",
  pptToPdf: "pptToPdf",
  htmlToPdf: "htmlToPdf",
  unlock: "unlock",
  crackPassword: "crackPassword",
  protect: "protect",
  removeWatermark: "removeWatermark",
  redact: "redactRegions",
  ocr: "ocrPdf",
  compare: "compare",
  summarize: "summarize",
};

// Tools that only work with the professional engine (no browser fallback).
// "redact" belongs here too: a black box alone doesn't remove the underlying
// content, so without the engine there's no safe fallback - only a real one.
// "unlock" belongs here for a related reason: pdf-lib has no real decryption
// support, so its only job - actually-encrypted PDFs - is exactly the case
// the browser fallback can't handle (confirmed: it used to silently produce
// an unopenable 0-page file). A no-op "browser" badge would be misleading
// for the one case anyone uses this tool for.
// "crackPassword" belongs here too: it's a server-side brute-force/dictionary
// job against pikepdf, with no meaningful in-browser equivalent (the browser
// has no bundled word list, and running thousands of pdf-lib decrypt attempts
// on the main thread would freeze the tab).
const ENGINE_REQUIRED_TOOLS = new Set(["removeWatermark", "redact", "summarize", "unlock", "crackPassword"]);

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

function hexToRgb(hex) {
  let clean = String(hex || "#111827").replace("#", "");
  if (clean.length === 3) clean = clean.split("").map((char) => char + char).join("");
  const value = parseInt(clean, 16);
  if (!Number.isFinite(value)) return rgb(0.07, 0.09, 0.15);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// parsePageRange now lives in ./lib/pageRange.js (imported above) so it can be
// unit-tested and stays consistent with the server engine's parse_page_spec.

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// So a freshly-placed Image annotation can start at the image's own aspect
// ratio instead of a fixed box that stretches every photo to the same
// roughly-4:3 shape (the preview and export both honor object-fit: fill,
// so that stretch was real, not just cosmetic - visible on every image
// placed until the user manually resized it).
function getImageAspect(dataUrl) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve((image.naturalWidth || 1) / (image.naturalHeight || 1));
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

function dataUrlToBytes(dataUrl) {
  const [, payload] = dataUrl.split(",");
  const binary = atob(payload);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body?.innerText || html.replace(/<[^>]+>/g, " ");
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const mod = (value - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    value = Math.floor((value - mod) / 26);
  }
  return name;
}

function columnIndexFromRef(ref = "A1") {
  const letters = String(ref).match(/[A-Z]+/i)?.[0] || "A";
  return letters.toUpperCase().split("").reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function splitFixedWidthTextLine(text) {
  const trimmed = String(text || "").replace(/\t/g, "    ").trim();
  if (!trimmed || /^[\-=_.\s]+$/.test(trimmed)) return [];
  const cells = trimmed.split(/\s{2,}/).map((cell) => cell.trim()).filter(Boolean);
  return cells.length ? cells : [trimmed];
}

function buildLineTextFromPositionedItems(items) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const widths = sorted
    .map((item) => item.w / Math.max(String(item.str || "").length, 1))
    .filter((value) => Number.isFinite(value) && value > 0);
  const charWidth = widths.length
    ? widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)]
    : 5;
  let text = "";
  let lastEnd = null;
  sorted.forEach((item) => {
    if (lastEnd != null) {
      const gap = item.x - lastEnd;
      if (gap > charWidth * 1.25) {
        text += " ".repeat(clamp(Math.round(gap / charWidth), 1, 40));
      }
    }
    text += item.str || "";
    lastEnd = Math.max(lastEnd ?? item.x, item.x + Math.max(item.w, charWidth));
  });
  return text.replace(/\u00a0/g, " ");
}

function clusterNumericColumns(positioned, pageWidth) {
  const numeric = positioned
    .filter((item) => item.x > pageWidth * 0.32 && /^-?\d+(?:\.\d+)?$|^-$/i.test(String(item.str || "").trim()))
    .map((item) => item.x)
    .sort((a, b) => a - b);
  const clusters = [];
  numeric.forEach((x) => {
    const cluster = clusters.find((entry) => Math.abs(entry.x - x) < 16);
    if (cluster) {
      cluster.values.push(x);
      cluster.x = cluster.values.reduce((sum, value) => sum + value, 0) / cluster.values.length;
    } else {
      clusters.push({ x, values: [x] });
    }
  });
  return clusters
    .filter((entry) => entry.values.length >= 2)
    .sort((a, b) => a.x - b.x)
    .slice(-5)
    .map((entry) => entry.x);
}

function parseReportLineFromPositions(line, columns) {
  const sorted = [...line.items].sort((a, b) => a.x - b.x);
  const textLine = buildLineTextFromPositionedItems(sorted);
  if (!sorted.length || !columns.length) return splitFixedWidthTextLine(textLine);
  const cells = Array.from({ length: columns.length + 1 }, () => "");
  const firstColumn = columns[0] - 10;
  sorted.forEach((item) => {
    const text = String(item.str || "").trim();
    if (!text) return;
    let target = 0;
    if (item.x >= firstColumn) {
      let bestIndex = 0;
      let bestDistance = Infinity;
      columns.forEach((x, index) => {
        const distance = Math.abs(item.x - x);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index + 1;
        }
      });
      target = bestDistance < 34 ? bestIndex : 0;
    }
    cells[target] = cells[target] ? `${cells[target]} ${text}` : text;
  });
  const compact = cells.map((cell) => cell.replace(/\s+/g, " ").trim());
  const usefulNumericCells = compact.slice(1).filter(Boolean).length;
  if (usefulNumericCells >= 2) {
    const trailingQuantity = compact[0].match(/^(.+\D)\s+(-?\d+(?:\.\d+)?)$/);
    const hasRateAmountPattern = compact.slice(1).some((cell) => /^\d+\.\d{2}$/.test(cell)) && compact.slice(2).some((cell) => /^\d+\.\d{2}$/.test(cell));
    if (trailingQuantity && hasRateAmountPattern) {
      return [trailingQuantity[1].trim(), trailingQuantity[2], ...compact.slice(1)];
    }
    return compact;
  }

  const fixedCells = splitFixedWidthTextLine(textLine);
  if (fixedCells.length > compact.filter(Boolean).length) return fixedCells;
  return compact.filter(Boolean);
}

function safeSheetName(name) {
  const cleaned = String(name || "Sheet").replace(/[\[\]:*?/\\]/g, " ").trim() || "Sheet";
  return cleaned.slice(0, 31);
}

async function createXlsxWorkbook(sheets) {
  const zip = new JSZip();
  const safeSheets = sheets.map((sheet, index) => ({
    name: safeSheetName(sheet.name || `Sheet ${index + 1}`),
    rows: sheet.rows || [],
  }));
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${safeSheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n  ")}
</Types>`);
  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.folder("xl").file("workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${safeSheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("\n    ")}
  </sheets>
</workbook>`);
  zip.folder("xl").folder("_rels").file("workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${safeSheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("\n  ")}
  <Relationship Id="rId${safeSheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.folder("xl").file("styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`);
  safeSheets.forEach((sheet, sheetIndex) => {
    const rowsXml = sheet.rows.map((row, rowIndex) => {
      const cellsXml = row.map((cell, cellIndex) => {
        const ref = `${columnName(cellIndex)}${rowIndex + 1}`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
      }).join("");
      return `<row r="${rowIndex + 1}">${cellsXml}</row>`;
    }).join("");
    zip.folder("xl").folder("worksheets").file(`sheet${sheetIndex + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowsXml}</sheetData>
</worksheet>`);
  });
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function extractXlsxText(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const parser = new DOMParser();
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("text");
  const shared = sharedXml
    ? [...parser.parseFromString(sharedXml, "application/xml").getElementsByTagName("si")]
        .map((node) => [...node.getElementsByTagName("t")].map((textNode) => textNode.textContent || "").join(""))
    : [];
  const workbookXml = await zip.file("xl/workbook.xml")?.async("text");
  if (!workbookXml) throw new Error("No workbook.xml found");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("text");
  const relTargets = {};
  if (relsXml) {
    [...parser.parseFromString(relsXml, "application/xml").getElementsByTagName("Relationship")].forEach((rel) => {
      relTargets[rel.getAttribute("Id")] = rel.getAttribute("Target");
    });
  }
  const workbook = parser.parseFromString(workbookXml, "application/xml");
  const sections = [];
  for (const sheet of [...workbook.getElementsByTagName("sheet")]) {
    const name = sheet.getAttribute("name") || "Sheet";
    const relId = sheet.getAttribute("r:id") || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const target = relTargets[relId] || `worksheets/sheet${sheet.getAttribute("sheetId") || 1}.xml`;
    const path = target.startsWith("/") ? target.replace(/^\/+/, "") : `xl/${target}`.replace(/xl\/xl\//, "xl/");
    const xml = await zip.file(path)?.async("text");
    if (!xml) continue;
    const doc = parser.parseFromString(xml, "application/xml");
    const lines = [];
    for (const row of [...doc.getElementsByTagName("row")]) {
      const cells = [];
      for (const cell of [...row.getElementsByTagName("c")]) {
        const col = columnIndexFromRef(cell.getAttribute("r") || "A1");
        const type = cell.getAttribute("t");
        const valueNode = cell.getElementsByTagName("v")[0];
        const inlineNode = cell.getElementsByTagName("is")[0];
        let value = "";
        if (type === "s") value = shared[Number(valueNode?.textContent || 0)] || "";
        else if (type === "inlineStr") value = [...(inlineNode?.getElementsByTagName("t") || [])].map((node) => node.textContent || "").join("");
        else value = valueNode?.textContent || "";
        cells[col] = value;
      }
      lines.push(cells.map((cell) => cell || "").join("\t").replace(/\s+$/g, ""));
    }
    sections.push(`Sheet: ${name}\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

function wrapPdfLine(text, font, size, maxWidth) {
  // Word-wrap lives in ./lib/textLayout.js (tested) - this adapts pdf-lib's
  // font.widthOfTextAtSize to the injectable `measure` signature it expects,
  // and fixes a real bug: a single token wider than maxWidth (a long URL, an
  // unbroken filename) used to be emitted whole and run off the page edge;
  // it is now hard-broken so no content is lost.
  return wrapLine(text, (t, s) => font.widthOfTextAtSize(t, s), size, maxWidth);
}

async function createPdfFromText(title, text) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 54;
  const size = 11;
  const lineHeight = 16;
  const maxWidth = 612 - margin * 2;
  let page = doc.addPage([612, 792]);
  let y = 738;
  page.drawText(title || "Converted document", { x: margin, y, size: 16, font: bold, color: rgb(0.08, 0.12, 0.18) });
  y -= 30;
  const writeLine = async (line) => {
    if (y < margin) {
      page = doc.addPage([612, 792]);
      y = 738;
    }
    page.drawText(line, { x: margin, y, size, font, color: rgb(0.1, 0.12, 0.16), maxWidth });
    y -= lineHeight;
  };
  for (const rawLine of String(text || "").replace(/\t/g, "    ").split(/\r?\n/)) {
    try {
      // wrapPdfLine measures with pdf-lib's Helvetica metrics, which throws
      // for the same non-WinAnsi characters page.drawText below would -
      // confirmed directly: a plain .txt file containing Japanese/Arabic/
      // Cyrillic/Devanagari text used to throw UNCAUGHT here (from the
      // measurement step, before drawText is even reached), aborting the
      // whole conversion with a generic "Conversion failed" message. Same
      // root cause already fixed for annotation export (drawTextSafely);
      // this path never got the same treatment.
      for (const wrapped of wrapPdfLine(rawLine, font, size, maxWidth)) {
        await writeLine(wrapped);
      }
    } catch (error) {
      console.warn("Line failed to render as vector text, rasterizing instead:", error.message);
      if (y < margin) { page = doc.addPage([612, 792]); y = 738; }
      const { image, width: imgW, height: imgH, scale } = await rasterizeAnnotationText(
        doc, { text: rawLine, fontSize: size, color: "#191f28" }, { width: maxWidth, height: lineHeight });
      const drawW = imgW / scale;
      const drawH = imgH / scale;
      page.drawImage(image, { x: margin, y: y + size - drawH, width: drawW, height: drawH });
      y -= lineHeight;
    }
    if (!rawLine.trim()) y -= 5;
  }
  return doc.save();
}

async function createPdfFromSlides(title, slides) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const [index, slide] of slides.entries()) {
    const page = doc.addPage([960, 540]);
    page.drawText(`${title || "PowerPoint"} - Slide ${index + 1}`, {
      x: 42,
      y: 492,
      size: 18,
      font: bold,
      color: rgb(0.08, 0.12, 0.18),
    });
    let y = 448;
    const lines = slide.length ? slide : ["No readable text found on this slide."];
    for (const line of lines) {
      try {
        for (const wrapped of wrapPdfLine(String(line || ""), font, 15, 840)) {
          if (y < 42) break;
          page.drawText(wrapped, { x: 58, y, size: 15, font, color: rgb(0.12, 0.14, 0.18) });
          y -= 24;
        }
      } catch (error) {
        // Same non-WinAnsi limitation as createPdfFromText above - a slide
        // with non-Latin text used to throw uncaught and abort the whole
        // PPTX conversion.
        console.warn("Slide line failed to render as vector text, rasterizing instead:", error.message);
        if (y < 42) continue;
        const { image, width: imgW, height: imgH, scale } = await rasterizeAnnotationText(
          doc, { text: String(line || ""), fontSize: 15, color: "#1f2429" }, { width: 840, height: 24 });
        const drawW = imgW / scale;
        const drawH = imgH / scale;
        page.drawImage(image, { x: 58, y: y + 15 - drawH, width: drawW, height: drawH });
        y -= 24;
      }
    }
  }
  if (!slides.length) {
    const page = doc.addPage([960, 540]);
    page.drawText("No slides found in this PowerPoint file.", { x: 48, y: 480, size: 18, font: bold, color: rgb(0.1, 0.12, 0.16) });
  }
  return doc.save();
}

async function extractPptxSlides(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const parser = new DOMParser();
  const slideFiles = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1] || 0) - Number(b.match(/slide(\d+)/i)?.[1] || 0));
  const slides = [];
  for (const path of slideFiles) {
    const xml = await zip.file(path).async("text");
    const doc = parser.parseFromString(xml, "application/xml");
    const lines = [...doc.getElementsByTagName("a:t")]
      .map((node) => node.textContent?.trim() || "")
      .filter(Boolean);
    slides.push(lines);
  }
  return slides;
}

function getImageSize(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
    image.onerror = reject;
    image.src = dataUrl;
  });
}

// Loads an image and re-draws it onto a canvas at its natural (displayed)
// size. Browsers apply a photo's EXIF orientation automatically when
// decoding for <img>/<canvas> - but pdf-lib's embedJpg/embedPng do not, they
// embed the raw pre-rotation pixel bytes. Embedding a phone photo's raw
// bytes directly (the old code here did exactly that) put portrait photos
// into the PDF sideways AND non-uniformly stretched, because the page/box
// was sized from the browser's correct (rotated) dimensions while the
// embedded pixel content was still the raw (unrotated) shape. Confirmed by
// reproducing it with a real EXIF-tagged JPEG and rendering the output.
// Canvas output has no EXIF tag left to lose, so its pixels are already
// upright and its width/height are the real displayed dimensions - one
// normalization step fixes both problems at once.
function normalizeImageOrientation(dataUrl, mimeType) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      canvas.toBlob(async (blob) => {
        if (!blob) { reject(new Error("Could not normalize image")); return; }
        resolve({
          bytes: new Uint8Array(await blob.arrayBuffer()),
          width: canvas.width,
          height: canvas.height,
        });
      }, mimeType, 0.92);
    };
    image.onerror = reject;
    image.src = dataUrl;
  });
}

async function createPdfFromImages(files) {
  const doc = await PDFDocument.create();
  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    const isPng = file.type.includes("png");
    const normalized = await normalizeImageOrientation(dataUrl, isPng ? "image/png" : "image/jpeg");
    const embedded = isPng ? await doc.embedPng(normalized.bytes) : await doc.embedJpg(normalized.bytes);
    const dimensions = { width: normalized.width, height: normalized.height };
    const landscape = dimensions.width > dimensions.height;
    const page = doc.addPage(landscape ? [792, 612] : [612, 792]);
    const size = page.getSize();
    const margin = 36;
    const scale = Math.min((size.width - margin * 2) / dimensions.width, (size.height - margin * 2) / dimensions.height);
    const width = dimensions.width * scale;
    const height = dimensions.height * scale;
    page.drawImage(embedded, {
      x: (size.width - width) / 2,
      y: (size.height - height) / 2,
      width,
      height,
    });
  }
  return doc.save();
}

function getCssFont(fontFamily) {
  return FONT_OPTIONS.find((font) => font.id === fontFamily)?.css || FONT_OPTIONS[0].css;
}

function getPdfBase(fontFamily) {
  return FONT_OPTIONS.find((font) => font.id === fontFamily)?.pdfBase || "helvetica";
}

function getPdfFont(fonts, annotation) {
  const family = getPdfBase(annotation.fontFamily);
  const style = annotation.bold && annotation.italic ? "boldItalic" : annotation.bold ? "bold" : annotation.italic ? "italic" : "regular";
  return fonts[family][style] || fonts[family].regular;
}

function inferFontFromPdf(style = {}, fontName = "") {
  const raw = `${style.fontFamily || ""} ${fontName}`.toLowerCase();
  const isMono = raw.includes("courier") || raw.includes("mono");
  // pdf.js reports the CSS generic family for any non-embedded standard font
  // (Helvetica, Arial, ...) as the literal string "sans-serif" - a plain
  // `raw.includes("serif")` matches that substring, so every such font (the
  // most common case of all) was misdetected as Times/serif. Confirmed via a
  // real fixture: a PDF using only Helvetica/Helvetica-Bold reported
  // style.fontFamily "sans-serif" for both, got mapped to "times", and any
  // edited text then rendered in a font with different glyph widths than the
  // untouched text around it - exactly the "disarranged text" symptom this
  // was reported as. Guard the "serif" substring against matching inside
  // "sans-serif" rather than dropping it, since real serif fonts still need
  // to match on it (e.g. a raw "serif" generic family with no "times").
  const isSerif = !isMono && (raw.includes("times") || raw.includes("roman") || /(?<!sans-)serif/.test(raw));
  const family = isMono ? "courier" : isSerif ? "times" : "helvetica";
  return {
    family,
    bold: raw.includes("bold") || raw.includes("black") || raw.includes("heavy"),
    italic: raw.includes("italic") || raw.includes("oblique"),
  };
}

function mapTextItemToBox(item, style, viewport) {
  // Geometry lives in the tested ./lib/textBoxes.js; font inference stays here.
  const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const geom = normalizedBoxFromTransform(transform, item, viewport);
  const inferred = inferFontFromPdf(style, item.fontName);
  return {
    id: uid(),
    str: item.str,
    ...geom,
    fontFamily: inferred.family,
    bold: inferred.bold,
    italic: inferred.italic,
    fontName: item.fontName,
    rawFamily: style?.fontFamily || "",
  };
}

function mapOcrBoxToDetected(item, sourceWidth, sourceHeight, pageSize) {
  const geom = ocrBoxToNormalized(item, sourceWidth, sourceHeight, pageSize);
  return {
    id: uid(),
    ...geom,
    fontFamily: "helvetica",
    bold: false,
    italic: false,
    fontName: "OCR",
    rawFamily: "OCR detected text",
    source: "ocr",
  };
}

function canvasLooksBlank(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const width = canvas.width;
  const height = canvas.height;
  if (!ctx || !width || !height) return false;
  const step = Math.max(24, Math.floor(Math.min(width, height) / 32));
  const data = ctx.getImageData(0, 0, width, height).data;
  let sampled = 0;
  let inked = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const a = data[offset + 3];
      sampled += 1;
      if (a > 12 && (r < 245 || g < 245 || b < 245)) inked += 1;
    }
  }
  return sampled > 0 && inked / sampled < 0.003;
}

function drawStyledText(page, annotation, box, fonts) {
  const font = getPdfFont(fonts, annotation);
  const size = annotation.fontSize || 18;
  const lineHeight = size * 1.25;
  // Wrap ourselves (tested in ./lib/textLayout.js) and DON'T also pass maxWidth
  // to pdf-lib's drawText below - pdf-lib auto-wraps internally when maxWidth is
  // set, which double-wrapped long lines against our own index*lineHeight
  // positions and made the next line overlap the wrapped remainder.
  const rawLines = String(annotation.text || "").split(/\r?\n/);
  const lines = rawLines.flatMap((raw) =>
    wrapLine(raw, (t, s) => font.widthOfTextAtSize(t, s), size, Math.max(1, box.width)));
  lines.forEach((line, index) => {
    const textWidth = font.widthOfTextAtSize(line, size);
    const extra = Math.max(0, box.width - textWidth);
    const alignOffset = annotation.align === "center" ? extra / 2 : annotation.align === "right" ? extra : 0;
    const lineX = box.x + alignOffset;
    const lineY = box.y + box.height - size - index * lineHeight;
    if (lineY < box.y - size) return;
    page.drawText(line, {
      x: lineX,
      y: lineY,
      size,
      font,
      color: hexToRgb(annotation.color || "#111827"),
      opacity: annotation.opacity ?? 1,
      rotate: annotation.type === "watermark" ? degrees(-24) : undefined,
    });
    if (annotation.underline && line) {
      page.drawLine({
        start: { x: lineX, y: lineY - 2 },
        end: { x: lineX + Math.min(textWidth, box.width), y: lineY - 2 },
        thickness: Math.max(0.7, size / 18),
        color: hexToRgb(annotation.color || "#111827"),
        opacity: annotation.opacity ?? 1,
      });
    }
  });
}

// pdf-lib's drawText only works with the Standard 14 fonts' WinAnsi encoding
// - it throws for ANY character outside Western European Latin script, which
// means it CANNOT draw Hindi, Arabic, Chinese, Tamil, or most other scripts
// at all (confirmed: 'राजेश कुमार', 'محمد أحمد', '张伟' all throw
// "WinAnsi cannot encode"). That's a real problem for a "name" or "passport
// number" field specifically, since passports are exactly where non-Latin
// names are common - and this app's own OCR already supports a dozen of
// these scripts. Properly shaping Arabic (contextual letter forms, RTL) or
// Devanagari (conjunct ligatures) needs a real text-shaping engine, which
// isn't practical to add here - but the BROWSER already does this correctly
// for any script, every time it renders the on-screen textarea. So instead
// of trying to reimplement shaping, this renders the exact same text through
// a canvas (using the browser's own font/shaping engine) and embeds the
// result as an image at the same position - correct for any language,
// because it's not vector text at all, it's a picture of correctly-shaped
// text. Used only as a fallback when drawStyledText's real vector text
// fails, so normal Latin-script edits still stay selectable/searchable text.
async function rasterizeAnnotationText(doc, annotation, box) {
  const scale = 4; // supersample for crisp text at typical PDF viewing zoom
  const width = Math.max(1, Math.round(box.width * scale));
  const height = Math.max(1, Math.round((box.height + (annotation.fontSize || 18) * 0.4) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const fontSize = (annotation.fontSize || 18) * scale;
  const weight = annotation.bold ? "700" : "400";
  const style = annotation.italic ? "italic" : "normal";
  ctx.font = `${style} ${weight} ${fontSize}px ${getCssFont(annotation.fontFamily)}`;
  ctx.fillStyle = annotation.color || "#111827";
  ctx.textBaseline = "top";
  // Hebrew + Arabic + their supplement/extension blocks - the common RTL
  // scripts this app's own OCR also supports (Arabic, Urdu). Character
  // shaping/reordering happens regardless of this flag (the browser's text
  // engine follows the Unicode bidi algorithm on the string itself) - but
  // `textAlign` MUST be set explicitly to "left" below, not left at its
  // "start" default: for direction="rtl", "start" anchors at the RIGHT
  // edge, so fillText(line, 0, y) draws the text extending into negative X,
  // off the canvas entirely - confirmed by reproducing it, Arabic text
  // silently vanished while Hindi/Chinese (which don't set rtl) rendered
  // fine right next to it.
  ctx.direction = /[֐-ࣿ]/.test(annotation.text || "") ? "rtl" : "ltr";
  ctx.textAlign = "left";
  const lines = String(annotation.text || "").split(/\r?\n/);
  const lineHeight = fontSize * 1.25;
  lines.forEach((line, index) => {
    const metrics = ctx.measureText(line);
    let lineX = 0;
    if (annotation.align === "center") lineX = Math.max(0, (width - metrics.width) / 2);
    else if (annotation.align === "right") lineX = Math.max(0, width - metrics.width);
    ctx.fillText(line, lineX, index * lineHeight);
  });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const pngBytes = new Uint8Array(await blob.arrayBuffer());
  const image = await doc.embedPng(pngBytes);
  return { image, width, height, scale };
}

// Tries real vector text first (selectable, searchable, small file size);
// falls back to rasterizing through the browser's own font engine only when
// that throws - which pdf-lib does for any script its Standard-14 fonts
// can't encode (see rasterizeAnnotationText above for why). This is what
// stops ONE annotation with, say, an Arabic name from silently aborting the
// entire export and losing every other edit on the document.
async function drawTextSafely(doc, page, annotation, box, fonts) {
  try {
    drawStyledText(page, annotation, box, fonts);
  } catch (error) {
    console.warn("Vector text failed, rendering as an image instead:", error.message);
    const { image, width, height, scale } = await rasterizeAnnotationText(doc, annotation, box);
    const imgWidthPt = width / scale;
    const imgHeightPt = height / scale;
    page.drawImage(image, {
      x: box.x,
      y: box.y + box.height - imgHeightPt,
      width: imgWidthPt,
      height: imgHeightPt,
      opacity: annotation.opacity ?? 1,
    });
  }
}

function drawArrowHead(page, start, end, color, thickness, opacity) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const size = Math.max(10, thickness * 5);
  const left = {
    x: end.x - size * Math.cos(angle - Math.PI / 6),
    y: end.y - size * Math.sin(angle - Math.PI / 6),
  };
  const right = {
    x: end.x - size * Math.cos(angle + Math.PI / 6),
    y: end.y - size * Math.sin(angle + Math.PI / 6),
  };
  page.drawLine({ start: end, end: left, thickness, color, opacity });
  page.drawLine({ start: end, end: right, thickness, color, opacity });
}

function App() {
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const pageStageRef = useRef(null);
  const fileRef = useRef(null);
  const mergeRef = useRef(null);
  const convertRef = useRef(null);
  const compareRef = useRef(null);
  const imageRef = useRef(null);
  const [pdfBytes, setPdfBytes] = useState(null);
  const [pdfDocProxy, setPdfDocProxy] = useState(null);
  const [fileName, setFileName] = useState("");
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState(PAPER);
  const [basePageSize, setBasePageSize] = useState(PAPER);
  const [zoom, setZoom] = useState(1.15);
  const [tool, setTool] = useState("select");
  const [annotations, setAnnotations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Drop a PDF to begin, or open one from your computer.");
  const [inkColor, setInkColor] = useState("#111827");
  const [fontSize, setFontSize] = useState(18);
  const [fontFamily, setFontFamily] = useState("helvetica");
  const [textBold, setTextBold] = useState(false);
  const [textItalic, setTextItalic] = useState(false);
  const [textUnderline, setTextUnderline] = useState(false);
  const [textAlign, setTextAlign] = useState("left");
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [opacity, setOpacity] = useState(0.9);
  const [stampText, setStampText] = useState("APPROVED");
  const [watermarkText, setWatermarkText] = useState("CONFIDENTIAL");
  const [rangeText, setRangeText] = useState("1");
  const [pendingImage, setPendingImage] = useState(null);
  const [pageTextItems, setPageTextItems] = useState([]);
  const [showTextGuides, setShowTextGuides] = useState(false);
  const [pageLooksBlank, setPageLooksBlank] = useState(false);
  const [ocrProgress, setOcrProgress] = useState("");
  const [ocrLanguage, setOcrLanguage] = useState(() => localStorage.getItem("pdfStudioOcrLanguage") || "eng");
  useEffect(() => {
    localStorage.setItem("pdfStudioOcrLanguage", ocrLanguage);
  }, [ocrLanguage]);
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const [studio, setStudio] = useState("pdf");
  const [photoPreset, setPhotoPreset] = useState(null);
  const [thumbs, setThumbs] = useState({});
  const renderTaskRef = useRef(null);
  // Pages already auto-OCR'd this document, so zooming/re-rendering a page
  // (which re-runs the page effect) doesn't re-trigger OCR every time -
  // only the first time a page turns out to have no real text layer.
  const autoOcrPagesRef = useRef(new Set());
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const [autoFitApplied, setAutoFitApplied] = useState(false);
  const [nativeEngine, setNativeEngine] = useState({ checked: false, ok: false, features: {}, office: {} });
  const [nativePassword, setNativePassword] = useState("");
  // A PDF that needs an open password can never make it into `pdfBytes` -
  // pdfjsLib.getDocument() rejects with PasswordException before the editor
  // ever sees it, so `pdfBytes` alone can't represent "user picked a file,
  // it's just locked." This holds the raw bytes for exactly that case, so
  // Unlock PDF and Recover PDF Password - the two tools whose entire job is
  // dealing with a PDF you can't otherwise open - have something to act on.
  const [lockedPdf, setLockedPdf] = useState(null);
  const [crackMode, setCrackMode] = useState("pin");
  const [crackMinLen, setCrackMinLen] = useState(4);
  const [crackMaxLen, setCrackMaxLen] = useState(8);
  const [crackCharsetLower, setCrackCharsetLower] = useState(true);
  const [crackCharsetUpper, setCrackCharsetUpper] = useState(false);
  const [crackCharsetDigits, setCrackCharsetDigits] = useState(true);
  const [crackCharsetSymbols, setCrackCharsetSymbols] = useState(false);
  const [crackWordlistFile, setCrackWordlistFile] = useState(null);
  const [crackJob, setCrackJob] = useState(null);
  const crackPollRef = useRef(null);
  const [protectPassword, setProtectPassword] = useState("");
  const [compressLevel, setCompressLevel] = useState("medium");
  const [removeWmMode, setRemoveWmMode] = useState("auto");
  const [removeWmText, setRemoveWmText] = useState("");
  const [apiBase, setApiBase] = useState(() => sessionStorage.getItem("pdfStudioApiBase") || "https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem("pdfStudioApiKey") || "");
  const [apiModel, setApiModel] = useState(() => sessionStorage.getItem("pdfStudioApiModel") || "gpt-4o-mini");
  const [aiPrompt, setAiPrompt] = useState("Guide me through the best tool for my current PDF task.");
  const [aiAnswer, setAiAnswer] = useState("");

  const pageAnnotations = useMemo(
    () => annotations.filter((item) => item.page === pageNumber),
    [annotations, pageNumber],
  );
  const selected = annotations.find((item) => item.id === selectedId) ?? null;

  const pushHistory = useCallback(() => {
    setHistory((items) => [...items.slice(-49), annotations]);
    setFuture([]);
  }, [annotations]);

  const updateAnnotation = useCallback((id, patch) => {
    setAnnotations((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const openPdfBytes = useCallback(async (bytes, name, options = {}) => {
    setBusy(true);
    setStatus("Opening PDF locally...");
    try {
      const loaded = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      setPdfBytes(bytes);
      setPdfDocProxy(loaded);
      setFileName(name.replace(/\.pdf$/i, ""));
      setPageCount(loaded.numPages);
      setPageNumber((page) => clamp(page, 1, loaded.numPages || 1));
      if (!options.keepAnnotations) setAnnotations([]);
      setSelectedId(null);
      if (!options.keepHistory) setHistory([]);
      setMatches([]);
      autoOcrPagesRef.current = new Set();
      setAutoFitApplied(false);
      setStatus(`${name} opened. Add edits, then export a new PDF.`);
      setLockedPdf(null);
    } catch (error) {
      console.error(error);
      if (error?.name === "PasswordException") {
        setLockedPdf({ bytes, name: name.replace(/\.pdf$/i, "") });
        setStatus("This PDF needs a password to open. Enter it in \"Unlock password\" and click Unlock PDF, or use Recover PDF Password if you don't know it.");
      } else {
        setStatus("Could not open that PDF. Try a non-encrypted file.");
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const loadPdf = useCallback(async (file) => {
    if (!file) return;
    const buffer = await file.arrayBuffer();
    await openPdfBytes(new Uint8Array(buffer), file.name, {});
  }, [openPdfBytes]);

  // Open one OR MANY PDFs. Selecting several files combines every page into one
  // document, in the order chosen - so "add all the papers together" just works
  // from the Open button. A single file opens normally.
  const openPdfFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []).filter((f) =>
      /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!files.length) return;
    if (files.length === 1) {
      await loadPdf(files[0]);
      return;
    }
    setBusy(true);
    setStatus(`Combining ${files.length} PDFs into one document...`);
    try {
      const buffers = await Promise.all(files.map((f) => f.arrayBuffer()));
      const merged = await mergePdfBytes(buffers.map((b) => new Uint8Array(b)), files.map((f) => f.name));
      const name = `${files[0].name.replace(/\.pdf$/i, "")}-combined.pdf`;
      await openPdfBytes(new Uint8Array(merged), name, {});
      setStatus(`Combined ${files.length} PDFs into one document. All pages are here and editable.`);
    } catch (error) {
      console.error(error);
      // mergePdfBytes now throws a specific, actionable message (which file,
      // and whether it's encrypted vs. just corrupt) - show that directly
      // instead of a generic fallback.
      setStatus(error.message?.includes("password-protected") || error.message?.includes("could not be read")
        ? error.message
        : "Could not combine those PDFs. One may be encrypted or damaged.");
    } finally {
      setBusy(false);
    }
  }, [loadPdf, openPdfBytes]);

  const refreshNativeEngine = useCallback(async () => {
    try {
      const response = await fetch(`${NATIVE_ENGINE_BASE}/api/native/status`);
      if (!response.ok) throw new Error("Native engine unavailable");
      const data = await response.json();
      setNativeEngine({ checked: true, ...data });
      return data;
    } catch {
      const data = { checked: true, ok: false, libreOffice: false, qpdf: false };
      setNativeEngine(data);
      return data;
    }
  }, []);

  useEffect(() => {
    refreshNativeEngine();
  }, [refreshNativeEngine]);

  const nativePdfRequest = async (endpoint, form) => {
    const response = await fetch(`${NATIVE_ENGINE_BASE}${endpoint}`, { method: "POST", body: form });
    if (!response.ok) {
      let detail = "";
      let needsPassword = false;
      try {
        const json = await response.json();
        detail = json.error || "";
        needsPassword = Boolean(json.needsPassword);
      } catch {
        detail = await response.text();
      }
      const error = new Error(detail || `Native engine failed (${response.status})`);
      error.needsPassword = needsPassword;
      throw error;
    }
    const disposition = response.headers.get("Content-Disposition") || "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "native-engine.out";
    let report = null;
    const encodedReport = response.headers.get("X-Engine-Report");
    if (encodedReport) {
      try {
        report = JSON.parse(decodeURIComponent(escape(atob(encodedReport))));
      } catch {
        report = null;
      }
    }
    return { bytes: new Uint8Array(await response.arrayBuffer()), filename, report };
  };

  const engineHas = (feature) => Boolean(nativeEngine.features && nativeEngine.features[feature]);

  // Which OCR engine the currently selected language will actually run on.
  // The server engine only advertises the languages it has models for; the
  // rest fall back to the browser, which is slower and has to download its
  // language data - worth saying before the user waits for a page.
  const ocrEngineForLanguage = () => {
    if (!engineHas("ocr")) return { label: "browser engine", pro: false };
    const supported = nativeEngine.ocrLanguages || [];
    if (supported.includes(ocrLanguage)) {
      return { label: nativeEngine.ocrEngine || "professional engine", pro: true };
    }
    return { label: "browser engine (no server model for this language)", pro: false };
  };

  // Send the current PDF (plus optional fields) to an engine endpoint and
  // download whatever file it returns. Returns the engine's JSON report.
  // Which bytes a tool should act on: the document open in the editor, or -
  // for a PDF that failed to open because it's password-locked - the raw
  // bytes stashed in `lockedPdf`. Only Unlock PDF and Recover PDF Password
  // need this fallback; every other tool requires a document that actually
  // rendered, so plain `pdfBytes` stays correct for them.
  const pdfSourceForTools = () => {
    if (pdfBytes) return { bytes: pdfBytes, name: fileName };
    if (lockedPdf) return { bytes: lockedPdf.bytes, name: lockedPdf.name };
    return null;
  };

  const engineProcessPdf = async (endpoint, fields, outName, mime, source) => {
    const { bytes: srcBytes, name: srcName } = source || { bytes: pdfBytes, name: fileName };
    const form = new FormData();
    form.append("file", new Blob([srcBytes], { type: "application/pdf" }), `${srcName || "document"}.pdf`);
    Object.entries(fields || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") form.append(key, value);
    });
    const { bytes, filename, report } = await nativePdfRequest(endpoint, form);
    if (outName !== null) {
      downloadBlob(new Blob([bytes], { type: mime || "application/pdf" }), outName || filename);
    }
    return { bytes, filename, report };
  };

  const convertFilesToPdf = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const imageFilesUpfront = files.filter((file) => file.type.startsWith("image/"));
    // The file picker allows multi-select (so several photos can become one
    // multi-page PDF below), but every non-image branch past this point only
    // ever reads files[0] - selecting 3 Word docs at once used to silently
    // convert just the first one and report success, with no sign the other
    // 2 were dropped. Refuse honestly instead, rather than a quiet no-op.
    if (files.length > 1 && imageFilesUpfront.length !== files.length) {
      setStatus(`Selected ${files.length} files, but only images can be combined here. Convert non-image files one at a time, or use Merge PDF to combine already-converted PDFs.`);
      return;
    }
    setBusy(true);
    setStatus("Converting file to PDF locally...");
    try {
      const first = files[0];
      let bytes;
      let name = first.name.replace(/\.[^.]+$/, "") || "converted";
      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      const isOffice = /\.(docx?|rtf|odt|xlsx?|xlsm|csv|ods|pptx?|ppsx?|odp)$/i.test(first.name);
      const isHtml = /\.(html?|htm)$/i.test(first.name) || first.type === "text/html";
      const officeFeature = /\.(docx?|rtf|odt)$/i.test(first.name) ? "wordToPdf"
        : /\.(xlsx?|xlsm|csv|ods)$/i.test(first.name) ? "excelToPdf"
        : /\.(pptx?|ppsx?|odp)$/i.test(first.name) ? "pptToPdf" : null;
      if ((isOffice && officeFeature && engineHas(officeFeature)) || (isHtml && engineHas("htmlToPdf"))) {
        try {
          const form = new FormData();
          form.append("file", first);
          const endpoint = isHtml ? "/api/native/html-to-pdf" : "/api/native/office-to-pdf";
          const native = await nativePdfRequest(endpoint, form);
          await openPdfBytes(native.bytes, native.filename || `${name}.pdf`, {});
          const engineName = native.report?.app || "native engine";
          setStatus(`${first.name} converted to PDF with ${engineName}.`);
          return;
        } catch (error) {
          console.warn(error);
          setStatus(`Native conversion failed (${error.message}). Falling back to browser engine...`);
        }
      }
      if (imageFiles.length === files.length) {
        bytes = await createPdfFromImages(imageFiles);
        name = imageFiles.length > 1 ? "converted-images" : name;
      } else if (first.name.toLowerCase().endsWith(".docx")) {
        const mammoth = await import("mammoth/mammoth.browser.js");
        const result = await mammoth.extractRawText({ arrayBuffer: await first.arrayBuffer() });
        bytes = await createPdfFromText(first.name, result.value || "");
      } else if (first.name.toLowerCase().endsWith(".xlsx")) {
        bytes = await createPdfFromText(first.name, await extractXlsxText(first));
      } else if (first.name.toLowerCase().endsWith(".xls")) {
        setStatus("Legacy .xls conversion is not supported locally yet. Save it as .xlsx or CSV, then convert again.");
        return;
      } else if (first.name.toLowerCase().endsWith(".pptx")) {
        bytes = await createPdfFromSlides(first.name, await extractPptxSlides(first));
      } else if (first.name.toLowerCase().endsWith(".ppt")) {
        setStatus("Legacy .ppt conversion is not supported locally yet. Save it as .pptx, then convert again.");
        return;
      } else if (first.type === "text/html" || first.name.toLowerCase().endsWith(".html") || first.name.toLowerCase().endsWith(".htm")) {
        bytes = await createPdfFromText(first.name, stripHtml(await first.text()));
      } else if (
        first.type.startsWith("text/") ||
        /\.(txt|csv|md|log)$/i.test(first.name)
      ) {
        bytes = await createPdfFromText(first.name, await first.text());
      } else if (first.type === "application/pdf" || first.name.toLowerCase().endsWith(".pdf")) {
        await loadPdf(first);
        return;
      } else {
        setStatus("Unsupported file type. Try PDF, DOCX, XLSX, PPTX, TXT, CSV, MD, HTML, PNG, or JPG.");
        return;
      }
      await openPdfBytes(new Uint8Array(bytes), `${name}.pdf`, {});
      setStatus(`${first.name} converted to PDF. You can edit and export it now.`);
    } catch (error) {
      console.error(error);
      setStatus("Conversion failed. Try a simpler file or a different format.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    async function renderPage() {
      if (!pdfDocProxy || !canvasRef.current) return;
      setBusy(true);
      try {
        if (renderTaskRef.current) {
          try { renderTaskRef.current.cancel(); } catch { /* previous task already settled */ }
        }
        const page = await pdfDocProxy.getPage(pageNumber);
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: zoom });
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        setPageSize({ width: viewport.width, height: viewport.height });
        setBasePageSize({ width: baseViewport.width, height: baseViewport.height });
        ctx.setTransform(outputScale, 0, 0, outputScale, 0, 0);
        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
        if (cancelled) return;
        const isBlank = canvasLooksBlank(canvas);
        setPageLooksBlank(isBlank);
        const text = await page.getTextContent();
        if (cancelled) return;
        const detected = text.items
          .filter((item) => item.str?.trim())
          .map((item) => mapTextItemToBox(item, text.styles?.[item.fontName], viewport));
        setPageTextItems(detected);
        if (tool === "editText") setStatus(`Detected ${detected.length} editable text fragments on page ${pageNumber}. Click one to replace it.`);
        if (detected.length < 2 && !autoOcrPagesRef.current.has(pageNumber) && !isBlank) {
          autoOcrPagesRef.current.add(pageNumber);
          runAutoOcrForPage(pageNumber);
        }
      } catch (error) {
        if (error?.name === "RenderingCancelledException" || cancelled) return;
        console.error(error);
        setStatus("Rendering stopped on this page. Try lowering zoom or reopening the PDF.");
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    renderPage();
    return () => {
      cancelled = true;
    };
  }, [pdfDocProxy, pageNumber, zoom]);

  useEffect(() => {
    if (!pdfDocProxy) {
      setThumbs({});
      return undefined;
    }
    let cancelled = false;
    setThumbs({});
    (async () => {
      const total = Math.min(pdfDocProxy.numPages, 300);
      for (let index = 1; index <= total; index += 1) {
        if (cancelled) return;
        try {
          const page = await pdfDocProxy.getPage(index);
          const scale = 96 / page.getViewport({ scale: 1 }).width;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
          if (cancelled) return;
          const url = canvas.toDataURL("image/jpeg", 0.7);
          setThumbs((items) => ({ ...items, [index]: url }));
        } catch (error) {
          // keep the numbered chip if one thumbnail fails
          console.warn("thumbnail failed for page", index, error);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfDocProxy]);

  useEffect(() => {
    const stage = pageStageRef.current;
    if (!stage) return undefined;
    const onWheel = (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setZoom((value) => clamp(value + (event.deltaY < 0 ? 0.12 : -0.12), 0.25, 4));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [studio, pdfDocProxy]);

  const fitPageToWidth = () => {
    if (!pageStageRef.current || !basePageSize.width) return;
    const available = pageStageRef.current.clientWidth - 28;
    setZoom(clamp(available / basePageSize.width, 0.25, 4));
  };

  useEffect(() => {
    if (!pdfDocProxy || autoFitApplied || !basePageSize.width || window.innerWidth > 720) return;
    fitPageToWidth();
    setAutoFitApplied(true);
  }, [pdfDocProxy, autoFitApplied, basePageSize.width]);

  useEffect(() => {
    if (tool === "editText" && pdfDocProxy) {
      setStatus(`${pageTextItems.length} text fragments detected on page ${pageNumber}. Click an outlined word or phrase to replace it.`);
    }
  }, [tool, pageTextItems.length, pageNumber, pdfDocProxy]);

  const pointFromEvent = (event) => {
    const rect = overlayRef.current.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1),
    };
  };

  const addAnnotation = (annotation) => {
    pushHistory();
    setAnnotations((items) => [...items, annotation]);
    setSelectedId(annotation.id);
  };

  const sampleBackgroundColor = (detected) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !ctx) return "#ffffff";
    const x0 = Math.floor(detected.x * canvas.width);
    const y0 = Math.floor(detected.y * canvas.height);
    const x1 = Math.floor((detected.x + detected.w) * canvas.width);
    const y1 = Math.floor((detected.y + detected.h) * canvas.height);
    const inset = Math.max(2, Math.floor(Math.min(canvas.width, canvas.height) * 0.002));
    const points = [
      [x0 + inset, y0 + inset],
      [x1 - inset, y0 + inset],
      [x0 + inset, y1 - inset],
      [x1 - inset, y1 - inset],
      [x0 + Math.floor((x1 - x0) / 2), y0 + inset],
      [x0 + Math.floor((x1 - x0) / 2), y1 - inset],
    ];
    const regionX = clamp(Math.min(x0, x1) - inset, 0, canvas.width - 1);
    const regionY = clamp(Math.min(y0, y1) - inset, 0, canvas.height - 1);
    const regionW = clamp(Math.abs(x1 - x0) + inset * 2, 1, canvas.width - regionX);
    const regionH = clamp(Math.abs(y1 - y0) + inset * 2, 1, canvas.height - regionY);
    const region = ctx.getImageData(regionX, regionY, regionW, regionH).data;
    const colors = points
      .map(([x, y]) => {
        const px = clamp(x, 0, canvas.width - 1) - regionX;
        const py = clamp(y, 0, canvas.height - 1) - regionY;
        const offset = (clamp(py, 0, regionH - 1) * regionW + clamp(px, 0, regionW - 1)) * 4;
        const r = region[offset];
        const g = region[offset + 1];
        const b = region[offset + 2];
        const a = region[offset + 3];
        return { r, g, b, a, brightness: (r + g + b) / 3 };
      })
      .filter((color) => color.a > 10)
      .sort((a, b) => b.brightness - a.brightness)
      .slice(0, 4);
    if (!colors.length) return "#ffffff";
    const avg = colors.reduce(
      (sum, color) => ({ r: sum.r + color.r, g: sum.g + color.g, b: sum.b + color.b }),
      { r: 0, g: 0, b: 0 },
    );
    return rgbToHex(avg.r / colors.length, avg.g / colors.length, avg.b / colors.length);
  };

  const makeTextEditAnnotation = (detected) => ({
    id: uid(),
    page: pageNumber,
    type: "textEdit",
    x: detected.x,
    y: detected.y,
    w: Math.min(0.98 - detected.x, Math.max(detected.w + 0.018, 0.05)),
    h: Math.max(detected.h, 0.022),
    text: detected.str,
    originalText: detected.str,
    color: inkColor,
    fontSize: detected.fontSize,
    fontFamily: detected.fontFamily,
    bold: detected.bold,
    italic: detected.italic,
    underline: false,
    align: "left",
    opacity: 1,
    coverOriginal: true,
    coverColor: detected.coverColor || sampleBackgroundColor(detected),
    coverPad: 1.5,
    detectedFontName: detected.fontName,
    detectedFamily: detected.rawFamily,
  });

  const editDetectedText = (detected) => {
    setFontFamily(detected.fontFamily);
    setFontSize(detected.fontSize);
    setTextBold(detected.bold);
    setTextItalic(detected.italic);
    setTextUnderline(false);
    setTextAlign("left");
    const annotation = makeTextEditAnnotation(detected);
    addAnnotation(annotation);
    setTool("select");
    setShowTextGuides(false);
    setStatus(`Editing detected text: "${detected.str.slice(0, 48)}". Export will cover the old text and write your replacement.`);
  };

  const convertPageTextToEditable = () => {
    if (!pageTextItems.length) {
      setStatus("No selectable text was detected on this page. If this is a scanned PDF, OCR is needed first.");
      return;
    }
    pushHistory();
    const existingKeys = new Set(
      annotations
        .filter((item) => item.page === pageNumber && item.type === "textEdit")
        .map((item) => `${Math.round(item.x * 10000)}:${Math.round(item.y * 10000)}:${item.originalText || item.text}`),
    );
    const editable = pageTextItems
      .filter((item) => !existingKeys.has(`${Math.round(item.x * 10000)}:${Math.round(item.y * 10000)}:${item.str}`))
      .map((item) => makeTextEditAnnotation(item));
    setAnnotations((items) => [...items, ...editable]);
    setTool("select");
    setShowTextGuides(false);
    setSelectedId(editable[0]?.id || null);
    setStatus(`Made ${editable.length} detected text fragments editable on page ${pageNumber}. Click any box and type.`);
  };

  // OCR now runs on the professional engine first (PP-OCRv4 / Tesseract on
  // the server, against the PDF at a resolution chosen for the recogniser)
  // and only falls back to tesseract.js in the browser.
  //
  // The browser engine stays as a fallback rather than being deleted, because
  // it is the only path that can OCR a language the server has no model for -
  // it downloads that traineddata on demand. But it cannot be the DEFAULT: it
  // needs that same download to work at all (so it fails outright offline or
  // behind a proxy), and it recognises the viewer canvas - the page at
  // whatever zoom is on screen, un-deskewed - which is why it produced
  // garbage on the scanned documents OCR exists for.
  const runEngineOcrPage = async (targetPage, language) => {
    const form = new FormData();
    form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), `${fileName || "document"}.pdf`);
    form.append("page", String(targetPage));
    form.append("lang", language);
    const response = await fetch(`${NATIVE_ENGINE_BASE}/api/native/ocr`, { method: "POST", body: form });
    if (!response.ok) {
      let detail = "";
      let unsupportedLanguage = false;
      try {
        const json = await response.json();
        detail = json.error || "";
        unsupportedLanguage = Boolean(json.unsupportedLanguage);
      } catch {
        detail = await response.text();
      }
      const error = new Error(detail || `OCR engine failed (${response.status})`);
      error.unsupportedLanguage = unsupportedLanguage;
      throw error;
    }
    return response.json();
  };

  // tesseract.js, in-browser. Returns detected boxes, or null if it failed.
  const runBrowserOcrPage = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const TesseractModule = await import("tesseract.js");
    const recognize = TesseractModule.default?.recognize || TesseractModule.recognize;
    const image = canvas.toDataURL("image/png");
    const result = await recognize(image, ocrLanguage, {
      logger: (message) => {
        if (message.status) {
          const pct = Number.isFinite(message.progress) ? ` ${Math.round(message.progress * 100)}%` : "";
          setOcrProgress(`${message.status}${pct}`);
        }
      },
    });
    const data = result.data || {};
    const rawItems = (data.lines?.length ? data.lines : data.words || [])
      .filter((item) => String(item.text || "").trim().length > 1)
      .filter((item) => (item.confidence ?? 80) > 25);
    return rawItems
      .map((item) => mapOcrBoxToDetected(item, canvas.width, canvas.height, basePageSize))
      .filter((item) => item.str);
  };

  const runOcrCurrentPage = async () => {
    if (!pdfDocProxy || !canvasRef.current) return;
    setBusy(true);
    setOcrProgress("Starting OCR...");
    let detected = null;
    let engineLabel = "";
    let note = "";
    try {
      if (engineHas("ocr") && pdfBytes) {
        setOcrProgress("Recognising on the engine...");
        setStatus(`Running OCR on page ${pageNumber} with the professional engine.`);
        try {
          const result = await runEngineOcrPage(pageNumber, ocrLanguage);
          detected = (result.words || [])
            .filter((word) => String(word.text || "").trim().length > 0)
            .map((word) => mapOcrBoxToDetected(word, result.width, result.height, basePageSize))
            .filter((item) => item.str);
          engineLabel = result.backend === "text-layer"
            ? "the page's own text layer (exact, not a guess)"
            : `${result.engine} at ${result.meanConfidence}% mean confidence`;
          if (result.skewAngle) note = ` Corrected ${Math.abs(result.skewAngle)}\u00b0 of scan skew.`;
        } catch (engineError) {
          // A language the server has no model for is not an error the user
          // needs to see - the browser engine can still fetch it.
          note = engineError.unsupportedLanguage
            ? " The engine has no model for that language, so the browser engine ran instead."
            : " The engine could not run, so the browser engine ran instead.";
          if (!engineError.unsupportedLanguage) console.error(engineError);
        }
      }
      if (!detected) {
        setStatus("Running OCR on this page in the browser. This can take a little while the first time.");
        detected = await runBrowserOcrPage();
        engineLabel = "the in-browser engine";
      }
      if (!detected || !detected.length) {
        setStatus(`OCR finished, but no readable text was found on page ${pageNumber}.${note} Try a clearer scan.`);
        return;
      }
      pushHistory();
      const editable = detected.map((item) => makeTextEditAnnotation(item));
      setAnnotations((items) => [...items, ...editable]);
      setTool("select");
      setSelectedId(editable[0]?.id || null);
      setPageTextItems((items) => [...items, ...detected]);
      // Unlike "Make Editable" on already-correct embedded PDF text, these
      // boxes hold the OCR engine's GUESS at the scanned image, and export
      // covers the original scan with that guess even for boxes never
      // touched - so an OCR misread (easy on numbers, tables, unusual fonts)
      // silently becomes the document's permanent "real" text. That risk
      // needs to be said out loud here, not left for the user to discover
      // after the original scan is already gone.
      setStatus(`OCR created ${editable.length} editable text box(es) on page ${pageNumber} using ${engineLabel}.${note} Review each one for misreads (especially numbers) before exporting - export replaces the original scanned text in these areas with what's in the boxes, even ones you never touched.`);
    } catch (error) {
      console.error(error);
      setStatus("OCR failed. The engine is unavailable and the browser engine could not download its language data - check your connection, then try again.");
    } finally {
      setBusy(false);
      setOcrProgress("");
    }
  };

  // A page with (near) zero native text is very likely a scan or a
  // flattened/image-only page - the exact case OCR exists for, but until
  // now the user had to already know that and manually click "Run OCR"
  // before search or click-to-edit worked at all; otherwise they just saw
  // "no text found" on a page that visibly has text. This runs OCR
  // automatically, once per page, and merges the result into pageTextItems
  // (search/click-to-edit) WITHOUT creating any editable annotations - that
  // stays an explicit action (the "Run OCR" button / clicking a detected
  // word), since auto-creating a page full of editable boxes the moment a
  // page loads would be a surprising, invasive side effect.
  const runAutoOcrForPage = async (targetPage) => {
    if (!pdfBytes || !canvasRef.current) return;
    setStatus(`Page ${targetPage} has no selectable text - detecting it with OCR...`);
    try {
      let detected = null;
      if (engineHas("ocr")) {
        try {
          const result = await runEngineOcrPage(targetPage, ocrLanguage);
          detected = (result.words || [])
            .filter((word) => String(word.text || "").trim().length > 0)
            .map((word) => mapOcrBoxToDetected(word, result.width, result.height, basePageSize))
            .filter((item) => item.str);
        } catch (engineError) {
          if (!engineError.unsupportedLanguage) console.warn("Auto-OCR engine pass failed:", engineError);
        }
      }
      if (!detected && targetPage === pageNumber) {
        detected = await runBrowserOcrPage();
      }
      if (detected && detected.length && targetPage === pageNumber) {
        setPageTextItems((items) => [...items, ...detected]);
        setStatus(`Detected ${detected.length} text fragment(s) on page ${targetPage} via OCR. Click any to edit it.`);
      } else if (targetPage === pageNumber) {
        setStatus(`No readable text was found on page ${targetPage}, even with OCR.`);
      }
    } catch (error) {
      console.warn("Auto-OCR failed:", error);
      if (targetPage === pageNumber) setStatus("Automatic OCR could not run on this page.");
    }
  };

  // "OCR PDF" (tool centre): the whole document, keeping the scan exactly as
  // it looks and adding an invisible text layer underneath it - so Ctrl+F,
  // copy/paste and any downstream text extraction work on it afterwards.
  // This is what "OCR a PDF" means everywhere else; the per-page button above
  // is the editing path, this is the document path.
  const ocrPdfSearchable = async () => {
    if (!pdfBytes) {
      setStatus("Open a PDF first.");
      return;
    }
    if (!engineHas("ocrPdf")) {
      runOcrCurrentPage();
      return;
    }
    setBusy(true);
    setOcrProgress("Recognising every page...");
    setStatus("Making this PDF searchable. Every page is recognised on the engine - this can take a while on a long scan.");
    try {
      const stem = (fileName || "document").replace(/\.pdf$/i, "");
      const { report } = await engineProcessPdf(
        "/api/native/ocr-pdf",
        { lang: ocrLanguage },
        `${stem}-searchable.pdf`,
        "application/pdf",
      );
      const pages = report?.pagesOcred ?? 0;
      const skipped = report?.pagesSkipped ?? 0;
      const skippedNote = skipped ? ` ${skipped} page(s) already had real text and were left untouched.` : "";
      setStatus(pages
        ? `Saved a searchable copy: ${report.words} words recognised across ${pages} page(s) with ${report.engine} at ${report.meanConfidence}% mean confidence.${skippedNote} The scan itself is unchanged - the text layer is invisible, underneath it.`
        : `No pages needed OCR - this PDF already has a real text layer.${skippedNote}`);
    } catch (error) {
      console.error(error);
      setStatus(`Could not make the PDF searchable: ${error.message}`);
    } finally {
      setBusy(false);
      setOcrProgress("");
    }
  };

  const detectedTextAtPoint = (point) => {
    // Nearest-center resolution so overlapping fragments (a word box inside a
    // line box) pick the one actually clicked, not just the first in the array.
    const direct = findBoxAtPoint(pageTextItems, point);
    if (direct) return direct;
    return pageTextItems
      .map((item) => {
        const cx = item.x + item.w / 2;
        const cy = item.y + item.h / 2;
        return { item, distance: Math.hypot(point.x - cx, point.y - cy) };
      })
      .filter((entry) => entry.distance < 0.035)
      .sort((a, b) => a.distance - b.distance)[0]?.item;
  };

  const handlePointerDown = (event) => {
    if (!pdfDocProxy || event.target.dataset.annotation === "true") return;
    if (tool === "pan" && pageStageRef.current) {
      event.preventDefault();
      const stage = pageStageRef.current;
      const start = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      const onMove = (moveEvent) => {
        stage.scrollLeft = start.left - (moveEvent.clientX - start.x);
        stage.scrollTop = start.top - (moveEvent.clientY - start.y);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }
    const point = pointFromEvent(event);
    if (tool === "editText") {
      const detected = detectedTextAtPoint(point);
      if (!detected) {
        setStatus("No selectable text found there. Try clicking directly on a word or use normal Text.");
        return;
      }
      editDetectedText(detected);
      return;
    }
    if (tool === "text") {
      addAnnotation({
        id: uid(),
        page: pageNumber,
        type: "text",
        x: point.x,
        y: point.y,
        w: 0.26,
        h: 0.055,
        // Empty, not the literal string "Type here" - that used to get
        // inserted as real text the user had to notice and delete by hand.
        // The textarea below shows "Type here" as an actual placeholder
        // (native browser behavior: greyed out, disappears the moment you
        // type, and an untouched box exports as nothing rather than a
        // stray "Type here" annotation on the page).
        text: "",
        color: inkColor,
        fontSize,
        fontFamily,
        bold: textBold,
        italic: textItalic,
        underline: textUnderline,
        align: textAlign,
        opacity,
      });
      return;
    }
    if (tool === "note") {
      addAnnotation({
        id: uid(),
        page: pageNumber,
        type: "note",
        x: point.x,
        y: point.y,
        w: 0.26,
        h: 0.14,
        text: "",
        color: "#111827",
        fill: "#fef3c7",
        fontSize: 14,
        fontFamily,
        bold: false,
        italic: false,
        underline: false,
        align: "left",
        opacity: 0.96,
      });
      return;
    }
    if (tool === "check") {
      addAnnotation({
        id: uid(),
        page: pageNumber,
        type: "check",
        x: point.x,
        y: point.y,
        w: 0.055,
        h: 0.055,
        color: inkColor,
        width: Math.max(3, strokeWidth),
        opacity,
      });
      return;
    }
    if (tool === "stamp") {
      addAnnotation({
        id: uid(),
        page: pageNumber,
        type: "stamp",
        x: point.x,
        y: point.y,
        w: 0.22,
        h: 0.08,
        text: stampText,
        color: inkColor,
        opacity,
      });
      return;
    }
    if (tool === "image") {
      if (!pendingImage) {
        imageRef.current?.click();
        setStatus("Choose an image, then click the page to place it.");
        return;
      }
      // Start the box at the image's own aspect ratio (falls back to the old
      // fixed 0.24 x 0.18 if decoding failed) - the preview and export both
      // stretch to fill the box exactly, so a wrong ratio here used to
      // visibly distort every image until manually resized.
      const boxW = 0.24;
      const boxH = pendingImage.aspect
        ? clamp((boxW * pageSize.width) / pendingImage.aspect / pageSize.height, 0.04, 0.7)
        : 0.18;
      addAnnotation({
        id: uid(),
        page: pageNumber,
        type: "image",
        x: point.x,
        y: point.y,
        w: boxW,
        h: boxH,
        dataUrl: pendingImage.dataUrl,
        mimeType: pendingImage.mimeType,
        opacity,
      });
      return;
    }
    if (tool === "pen" || tool === "signature") {
      setDraft({
        id: uid(),
        page: pageNumber,
        type: tool,
        color: tool === "signature" ? "#111827" : inkColor,
        width: tool === "signature" ? Math.max(3, strokeWidth) : strokeWidth,
        opacity,
        points: [point],
      });
      return;
    }
    if (["highlight", "rectangle", "ellipse", "line", "arrow", "redact", "eraser"].includes(tool)) {
      setDraft({
        id: uid(),
        page: pageNumber,
        // Reuses the "type" name as its own CSS class (see the render list
        // below), so "eraser" gets its own .annotation.eraser look - a
        // white fill would be invisible on a white page, so that class uses
        // a visible dashed/tinted style instead. The exported PDF still
        // gets a real white fill from the engine, independent of this.
        type: tool,
        x: point.x,
        y: point.y,
        w: 0.001,
        h: 0.001,
        start: point,
        color: tool === "highlight" ? "#facc15" : tool === "eraser" ? "#ffffff" : inkColor,
        width: strokeWidth,
        opacity: tool === "highlight" ? 0.34 : opacity,
        ...(tool === "line" || tool === "arrow"
          ? { x1: point.x, y1: point.y, x2: point.x, y2: point.y }
          : {}),
      });
      return;
    }
    setSelectedId(null);
  };

  const handlePointerMove = (event) => {
    if (!draft) return;
    const point = pointFromEvent(event);
    if (draft.points) {
      setDraft((item) => ({ ...item, points: [...item.points, point] }));
      return;
    }
    const x = Math.min(draft.start.x, point.x);
    const y = Math.min(draft.start.y, point.y);
    const w = Math.abs(point.x - draft.start.x);
    const h = Math.abs(point.y - draft.start.y);
    setDraft((item) => ({
      ...item,
      x,
      y,
      w,
      h,
      ...(item.x1 != null ? { x2: point.x, y2: point.y } : {}),
    }));
  };

  const handlePointerUp = () => {
    if (!draft) return;
    const finished = { ...draft };
    delete finished.start;
    setDraft(null);
    if (finished.points && finished.points.length < 2) return;
    if (finished.x1 != null) {
      if (Math.hypot(finished.x2 - finished.x1, finished.y2 - finished.y1) < 0.008) return;
      finished.w = Math.max(finished.w, 0.002);
      finished.h = Math.max(finished.h, 0.002);
    } else if (!finished.points && (finished.w < 0.01 || finished.h < 0.01)) {
      return;
    }
    addAnnotation(finished);
  };

  const moveAnnotation = (id, event) => {
    event.stopPropagation();
    setSelectedId(id);
    if (tool === "eraser") {
      pushHistory();
      setAnnotations((items) => items.filter((item) => item.id !== id));
      setSelectedId(null);
      return;
    }
    if (tool !== "select") return;
    const start = pointFromEvent(event);
    const original = annotations.find((item) => item.id === id);
    if (!original || original.points) return;
    pushHistory();

    const onMove = (moveEvent) => {
      const next = pointFromEvent(moveEvent);
      const patch = translateShape(original, next.x - start.x, next.y - start.y);
      updateAnnotation(id, patch);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const resizeAnnotation = (id, corner, event) => {
    event.stopPropagation();
    const start = pointFromEvent(event);
    const original = annotations.find((item) => item.id === id);
    if (!original || original.points) return;
    pushHistory();

    const onMove = (moveEvent) => {
      const next = pointFromEvent(moveEvent);
      const patch = resizeShape(original, corner, next.x - start.x, next.y - start.y);
      updateAnnotation(id, patch);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    pushHistory();
    setAnnotations((items) => items.filter((item) => item.id !== selectedId));
    setSelectedId(null);
  };

  const duplicateSelected = () => {
    const item = annotations.find((entry) => entry.id === selectedId);
    if (!item) return;
    pushHistory();
    const copy = { ...item, id: uid(), ...offsetForDuplicate(item) };
    setAnnotations((items) => [...items, copy]);
    setSelectedId(copy.id);
  };

  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setFuture((items) => [...items, annotations]);
    setAnnotations(previous);
    setHistory((items) => items.slice(0, -1));
    setSelectedId(null);
  };

  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    setHistory((items) => [...items, annotations]);
    setAnnotations(next);
    setFuture((items) => items.slice(0, -1));
    setSelectedId(null);
  };

  const nudgeSelected = (dx, dy) => {
    const item = annotations.find((entry) => entry.id === selectedId);
    if (!item) return;
    updateAnnotation(item.id, nudgeShape(item, dx, dy));
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      const typing = tag === "textarea" || tag === "input" || tag === "select";
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !typing && key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !typing && (key === "y" || (key === "z" && event.shiftKey))) {
        event.preventDefault();
        redo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !typing && key === "d" && selectedId) {
        event.preventDefault();
        duplicateSelected();
        return;
      }
      if (event.key === "Escape") {
        setDraft(null);
        setSelectedId(null);
        document.activeElement?.blur?.();
        return;
      }
      if (typing) return;
      if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
        event.preventDefault();
        deleteSelected();
        return;
      }
      if (selectedId && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        const step = event.shiftKey ? 0.01 : 0.002;
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        nudgeSelected(dx, dy);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, annotations, history, future]);

  const rotatePage = () => {
    if (!pdfBytes) return;
    addAnnotation({
      id: uid(),
      page: pageNumber,
      type: "rotate",
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      degrees: 90,
    });
    setStatus(`Page ${pageNumber} will rotate 90 degrees on export.`);
  };

  // Finds every occurrence with its actual on-page position (not just "this
  // page has a match somewhere"), so results can be highlighted and jumped
  // to. Pages with no real text layer (scanned/flattened) fall back to OCR
  // instead of being silently unsearchable - the same gap that made
  // click-to-edit look broken on exactly those documents.
  const searchPdf = async () => {
    if (!pdfDocProxy || !query.trim()) {
      setMatches([]);
      setMatchIndex(0);
      return;
    }
    setBusy(true);
    const q = query.trim().toLowerCase();
    try {
      const found = [];
      for (let index = 1; index <= pageCount; index += 1) {
        setStatus(`Searching page ${index} of ${pageCount}...`);
        const page = await pdfDocProxy.getPage(index);
        const viewport = page.getViewport({ scale: 1 });
        const text = await page.getTextContent();
        let items = text.items
          .filter((item) => item.str?.trim())
          .map((item) => mapTextItemToBox(item, text.styles?.[item.fontName], viewport));
        if (items.length < 2) {
          try {
            if (engineHas("ocr")) {
              setStatus(`Searching page ${index} of ${pageCount} - no text layer, running OCR...`);
              const result = await runEngineOcrPage(index, ocrLanguage);
              items = (result.words || [])
                .filter((word) => String(word.text || "").trim())
                .map((word) => mapOcrBoxToDetected(word, result.width, result.height, viewport))
                .filter((item) => item.str);
            }
          } catch (error) {
            console.warn(`Search OCR failed on page ${index}:`, error);
          }
        }
        for (const item of items) {
          if ((item.str || "").toLowerCase().includes(q)) {
            found.push({ page: index, x: item.x, y: item.y, w: item.w, h: item.h, text: item.str });
          }
        }
      }
      setMatches(found);
      setMatchIndex(0);
      if (found.length) {
        setPageNumber(found[0].page);
        const pages = new Set(found.map((m) => m.page)).size;
        setStatus(`Found ${found.length} match(es) on ${pages} page(s). Showing 1 of ${found.length}.`);
      } else {
        setStatus("No text matches found (checked the text layer and OCR).");
      }
    } finally {
      setBusy(false);
    }
  };

  const gotoMatch = (delta) => {
    if (!matches.length) return;
    // Only ever called with delta=+-1 today (the two nav buttons), where
    // adding matches.length once is enough to stay positive - but that's
    // not a true modulo, so any future caller passing a larger jump (e.g.
    // a "jump N matches" feature or a keyboard shortcut) could still land
    // negative and index matches[-N] (undefined). Double-mod is the actual
    // fix, costs nothing for the current +-1 usage.
    const next = ((matchIndex + delta) % matches.length + matches.length) % matches.length;
    setMatchIndex(next);
    setPageNumber(matches[next].page);
    setStatus(`Match ${next + 1} of ${matches.length} on page ${matches[next].page}.`);
  };

  const getPdfPlainText = async () => {
    if (!pdfDocProxy) return "";
    const sections = [];
    for (let index = 1; index <= pageCount; index += 1) {
      const page = await pdfDocProxy.getPage(index);
      const text = await page.getTextContent();
      const baseText = text.items.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim();
      const annotationText = annotations
        .filter((item) => item.page === index && ["text", "textEdit", "note", "stamp", "watermark"].includes(item.type))
        .map((item) => item.text)
        .filter(Boolean)
        .join("\n");
      sections.push(`Page ${index}\n${baseText}${annotationText ? `\n\nAnnotations:\n${annotationText}` : ""}`);
    }
    return sections.join("\n\n---\n\n");
  };

  const exportPdfAsText = async () => {
    setBusy(true);
    try {
      const text = await getPdfPlainText();
      downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `${fileName || "document"}.txt`);
      setStatus("Saved PDF text as TXT.");
    } catch (error) {
      console.error(error);
      setStatus("Could not export text from this PDF.");
    } finally {
      setBusy(false);
    }
  };

  const exportPdfAsCsv = async () => {
    setBusy(true);
    try {
      const rows = [["page", "text"]];
      for (let index = 1; index <= pageCount; index += 1) {
        const page = await pdfDocProxy.getPage(index);
        const text = await page.getTextContent();
        const line = text.items.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim();
        rows.push([String(index), line]);
      }
      const csv = rows
        .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
        .join("\n");
      downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${fileName || "document"}-text.csv`);
      setStatus("Saved PDF text as CSV.");
    } catch (error) {
      console.error(error);
      setStatus("Could not export CSV from this PDF.");
    } finally {
      setBusy(false);
    }
  };

  const getPdfTableRows = async () => {
    const dataRows = [];
    let maxColumns = 0;
    for (let index = 1; index <= pageCount; index += 1) {
      const page = await pdfDocProxy.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      const text = await page.getTextContent();
      const positioned = text.items
        .filter((item) => item.str?.trim())
        .map((item) => {
          const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
          return { str: item.str, x: transform[4], y: transform[5], w: (item.width || String(item.str).length * 5) };
        })
        .sort((a, b) => b.y - a.y || a.x - b.x);
      const smartColumns = clusterNumericColumns(positioned, viewport.width);
      const lines = [];
      positioned.forEach((item) => {
        const line = lines.find((entry) => Math.abs(entry.y - item.y) < 4);
        if (line) {
          line.items.push(item);
          line.y = (line.y + item.y) / 2;
        } else {
          lines.push({ y: item.y, items: [item] });
        }
      });
      lines
        .sort((a, b) => b.y - a.y)
        .forEach((line, lineIndex) => {
          const textLine = buildLineTextFromPositionedItems(line.items);
          const cells = smartColumns.length >= 3
            ? parseReportLineFromPositions(line, smartColumns)
            : splitFixedWidthTextLine(textLine);
          if (!cells.length) return;
          if (cells.length === 1 && /^[\-=_.\s]+$/.test(cells[0])) return;
          maxColumns = Math.max(maxColumns, cells.length);
          dataRows.push([String(index), String(lineIndex + 1), ...cells]);
        });
    }
    if (!dataRows.length) {
      return [
        ["Status", "Next step"],
        ["No selectable PDF text found", "Run OCR PDF first, then export to XLSX again."],
      ];
    }
    const standardHeaders = ["Description / Text", "Qty", "Free", "Rate", "Amount", "%"];
    return [
      ["Page", "Line", ...Array.from({ length: maxColumns }, (_, index) => standardHeaders[index] || `Value ${index}`)],
      ...dataRows.map((row) => [...row, ...Array.from({ length: Math.max(0, maxColumns + 2 - row.length) }, () => "")]),
    ];
  };

  const getPdfOcrTableRows = async () => {
    // Same engine-first rule as the page button: the server recogniser reads
    // the PDF itself at a resolution chosen for OCR, where the browser one
    // only ever sees a canvas render at the current zoom.
    const useEngine = engineHas("ocr") && Boolean(pdfBytes);
    const ocrPageLines = async (index) => {
      if (useEngine) {
        const result = await runEngineOcrPage(index, ocrLanguage);
        return (result.lines || []).map((line) => line.text || "");
      }
      const TesseractModule = await import("tesseract.js");
      const recognize = TesseractModule.default?.recognize || TesseractModule.recognize;
      const page = await pdfDocProxy.getPage(index);
      const viewport = page.getViewport({ scale: 1.7 });
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const result = await recognize(canvas.toDataURL("image/png"), ocrLanguage, {
        logger: (message) => {
          if (message.status) {
            const pct = Number.isFinite(message.progress) ? ` ${Math.round(message.progress * 100)}%` : "";
            setStatus(`OCR to Excel page ${index}/${pageCount}: ${message.status}${pct}`);
          }
        },
      });
      return result.data?.lines?.length
        ? result.data.lines.map((line) => line.text || "")
        : String(result.data?.text || "").split(/\r?\n/);
    };
    const dataRows = [];
    let maxColumns = 0;
    for (let index = 1; index <= pageCount; index += 1) {
      setStatus(`No text layer found. Running OCR for Excel export: page ${index} of ${pageCount}...`);
      const rawLines = await ocrPageLines(index);
      rawLines.forEach((rawLine, lineIndex) => {
        const cells = splitFixedWidthTextLine(rawLine);
        if (!cells.length) return;
        maxColumns = Math.max(maxColumns, cells.length);
        dataRows.push([String(index), String(lineIndex + 1), ...cells]);
      });
    }
    if (!dataRows.length) {
      return [
        ["Status", "Next step"],
        ["OCR did not find table text", "Try a clearer scan or higher quality PDF."],
      ];
    }
    const standardHeaders = ["Description / Text", "Qty", "Free", "Rate", "Amount", "%"];
    return [
      ["Page", "Line", ...Array.from({ length: maxColumns }, (_, index) => standardHeaders[index] || `Column ${index + 1}`)],
      ...dataRows.map((row) => [...row, ...Array.from({ length: Math.max(0, maxColumns + 2 - row.length) }, () => "")]),
    ];
  };

  const exportPdfAsXlsx = async () => {
    if (!pdfDocProxy) return;
    setBusy(true);
    try {
      if (engineHas("pdfToExcel")) {
        setStatus("Detecting tables and building a real Excel workbook...");
        const { report } = await engineProcessPdf(
          "/api/native/pdf-to-excel", {},
          `${fileName || "document"}.xlsx`,
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        setStatus(report?.tables
          ? `Saved Excel workbook: ${report.tables} table(s) detected across ${report.sheets} sheet(s).`
          : `Saved Excel workbook with ${report?.sheets || 1} sheet(s) of extracted text.`);
        return;
      }
      let rows = await getPdfTableRows();
      const needsOcr = rows[1]?.[0] === "No selectable PDF text found";
      if (needsOcr) rows = await getPdfOcrTableRows();
      const blob = await createXlsxWorkbook([{ name: "PDF Text", rows }]);
      downloadBlob(blob, `${fileName || "document"}-text.xlsx`);
      setStatus(rows.length > 2 ? `Saved PDF as Excel XLSX with ${rows.length - 1} extracted row(s).` : "Saved XLSX note: no table text was found.");
    } catch (error) {
      console.error(error);
      setStatus("Could not export Excel from this PDF.");
    } finally {
      setBusy(false);
    }
  };

  const exportPdfAsDocx = async () => {
    setBusy(true);
    try {
      if (pdfBytes && engineHas("pdfToWord")) {
        setStatus("Converting to Word with layout-preserving engine...");
        const { report } = await engineProcessPdf(
          "/api/native/pdf-to-word", {},
          `${fileName || "document"}.docx`,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );
        setStatus(report?.fidelity === "layout"
          ? "Saved a Word document that preserves layout, tables, and images."
          : "Saved a Word document with the extracted text.");
        return;
      }
      const { Document, Packer, Paragraph, TextRun } = await import("docx");
      const text = await getPdfPlainText();
      const doc = new Document({
        sections: [{
          children: text.split(/\r?\n/).map((line) => new Paragraph({ children: [new TextRun(line || " ")] })),
        }],
      });
      const blob = await Packer.toBlob(doc);
      downloadBlob(blob, `${fileName || "document"}-text.docx`);
      setStatus("Saved PDF text as DOCX.");
    } catch (error) {
      console.error(error);
      setStatus("Could not export DOCX from this PDF.");
    } finally {
      setBusy(false);
    }
  };

  const exportCurrentPagePng = async () => {
    if (!canvasRef.current) return;
    canvasRef.current.toBlob((blob) => {
      if (!blob) {
        setStatus("Could not export the current page image.");
        return;
      }
      downloadBlob(blob, `${fileName || "document"}-page-${pageNumber}.png`);
      setStatus("Saved current page as PNG.");
    }, "image/png");
  };

  const exportAllPagesPngZip = async (format = "png") => {
    if (!pdfDocProxy) return;
    setBusy(true);
    try {
      if (pdfBytes && engineHas("pdfToImages")) {
        setStatus(`Rendering all pages to ${format.toUpperCase()} at 200 DPI with the engine...`);
        const { report } = await engineProcessPdf(
          "/api/native/pdf-to-images",
          { dpi: "200", format },
          `${fileName || "document"}-${format}-pages.zip`,
          "application/zip",
        );
        setStatus(`Saved ${report?.pages || pageCount} page(s) as ${format.toUpperCase()} at ${report?.dpi || 200} DPI in a ZIP.`);
        return;
      }
      const zip = new JSZip();
      for (let index = 1; index <= pageCount; index += 1) {
        const page = await pdfDocProxy.getPage(index);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        zip.file(`${fileName || "document"}-page-${String(index).padStart(3, "0")}.png`, blob);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      downloadBlob(blob, `${fileName || "document"}-pages-png.zip`);
      setStatus("Saved all PDF pages as PNG ZIP.");
    } catch (error) {
      console.error(error);
      setStatus(`Could not export page images: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const exportPdfAsPptx = async () => {
    if (!pdfBytes) return;
    if (!engineHas("pdfToPpt")) {
      await exportAllPagesPngZip("png");
      setStatus("Saved slide-ready page images (PNG ZIP). Import them into PowerPoint as slides, or run the engine for a real .pptx.");
      return;
    }
    setBusy(true);
    try {
      setStatus("Building a real PowerPoint deck, one slide per page...");
      const { report } = await engineProcessPdf(
        "/api/native/pdf-to-ppt",
        { dpi: "150" },
        `${fileName || "document"}.pptx`,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      );
      setStatus(`Saved a PowerPoint deck with ${report?.slides || pageCount} slide(s).`);
    } catch (error) {
      console.error(error);
      setStatus(`Could not build the PowerPoint deck: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  // Flagship: professional, mostly-lossless PDF watermark removal.
  const removeWatermark = async () => {
    if (!pdfBytes) {
      setStatus("Open a PDF first, then remove its watermark.");
      return;
    }
    if (!engineHas("removeWatermark")) {
      setStatus("Watermark removal needs the professional engine. Run `npm.cmd run engine` beside Vite, then Refresh engine status.");
      return;
    }
    setBusy(true);
    try {
      const fields = { mode: removeWmMode };
      if (removeWmMode === "text") {
        if (!removeWmText.trim()) {
          setStatus("Type the exact watermark text to remove, then try again.");
          setBusy(false);
          return;
        }
        fields.text = removeWmText.trim();
      }
      setStatus(`Removing watermark (${removeWmMode} mode) at the PDF-object level...`);
      const { bytes, report } = await engineProcessPdf("/api/native/remove-watermark", fields, null);
      await openPdfBytes(bytes, `${fileName || "document"}-clean.pdf`, {});
      const parts = [];
      if (report?.textInstancesRemoved) parts.push(`${report.textInstancesRemoved} text mark(s)`);
      if (report?.imagesRemoved) parts.push(`${report.imagesRemoved} image mark(s)`);
      if (report?.layersRemoved) parts.push(`${report.layersRemoved} layer(s)`);
      if (report?.annotsRemoved) parts.push(`${report.annotsRemoved} stamp annotation(s)`);
      if (report?.regionsRedacted) parts.push(`${report.regionsRedacted} region(s)`);
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), `${fileName || "document"}-clean.pdf`);
      setStatus(parts.length
        ? `Removed ${parts.join(", ")}. Cleaned PDF opened and downloaded; the original is untouched.`
        : "No watermark objects were detected. Try 'Text' mode with the exact watermark text, or the redact-region option.");
    } catch (error) {
      console.error(error);
      setStatus(`Watermark removal failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const cropCurrentPageToSelection = async () => {
    if (!pdfBytes) return;
    const cropItem = selected && !selected.points && selected.page === pageNumber && selected.w && selected.h ? selected : null;
    if (!cropItem) {
      setStatus("Select a rectangle, highlight, redaction, or image-sized box first, then use Crop PDF.");
      return;
    }
    setBusy(true);
    try {
      const doc = await PDFDocument.load(pdfBytes);
      const page = doc.getPage(pageNumber - 1);
      const size = page.getSize();
      const x = cropItem.x * size.width;
      const y = size.height - cropItem.y * size.height - cropItem.h * size.height;
      const w = cropItem.w * size.width;
      const h = cropItem.h * size.height;
      page.setCropBox(x, y, w, h);
      const bytes = await doc.save();
      await openPdfBytes(new Uint8Array(bytes), `${fileName || "cropped"}.pdf`, { keepAnnotations: true, keepHistory: true });
      setStatus(`Cropped page ${pageNumber} to the selected area.`);
    } catch (error) {
      console.error(error);
      setStatus("Could not crop this PDF page.");
    } finally {
      setBusy(false);
    }
  };

  const compressPdf = async (level = compressLevel) => {
    if (!pdfBytes) return;
    setBusy(true);
    try {
      if (engineHas("compress")) {
        setStatus(`Compressing with the professional engine (${level})...`);
        const { report } = await engineProcessPdf(
          "/api/native/compress",
          { level },
          `${fileName || "document"}-compressed.pdf`,
        );
        if (report) {
          const kinds = [];
          if (report.grayscaleImages) kinds.push(`${report.grayscaleImages} grayscale`);
          if (report.graphicImages) kinds.push(`${report.graphicImages} graphic (lossless)`);
          if (report.photoImages) kinds.push(`${report.photoImages} photo`);
          setStatus(`Compressed ${report.beforeKB} KB -> ${report.afterKB} KB (${report.savedPct}% smaller`
            + `${report.downsampledImages ? `, ${report.downsampledImages} image(s) re-encoded content-aware: ${kinds.join(", ")}` : ""}). Text stays selectable.`);
        } else {
          setStatus("Compressed PDF with the professional engine.");
        }
        return;
      }
      const doc = await PDFDocument.load(pdfBytes);
      const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), `${fileName || "document"}-compressed.pdf`);
      setStatus("Compressed PDF structure with the browser engine and downloaded a new file.");
    } catch (error) {
      console.error(error);
      setStatus(/encrypted/i.test(error.message || "")
        ? "This PDF is encrypted, so the browser compress engine can't rebuild it. Start the professional engine (`npm.cmd run engine`) and try again."
        : `Could not compress this PDF: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const compressPdfStrong = async (dpi = 150, quality = 0.72) => {
    if (pdfBytes && engineHas("compress")) {
      await compressPdf("strong");
      return;
    }
    if (!pdfDocProxy || !pdfBytes) return;
    setBusy(true);
    setStatus("Strong compress: re-rendering pages as optimized images...");
    try {
      const out = await PDFDocument.create();
      for (let index = 1; index <= pageCount; index += 1) {
        const page = await pdfDocProxy.getPage(index);
        const viewport = page.getViewport({ scale: dpi / 72 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        const jpg = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
        const base = page.getViewport({ scale: 1 });
        const newPage = out.addPage([base.width, base.height]);
        newPage.drawImage(jpg, { x: 0, y: 0, width: base.width, height: base.height });
        setStatus(`Strong compress: page ${index} / ${pageCount}...`);
      }
      const bytes = await out.save({ useObjectStreams: true });
      const beforeKb = Math.round(pdfBytes.length / 1024);
      const afterKb = Math.round(bytes.length / 1024);
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), `${fileName || "document"}-compressed-strong.pdf`);
      setStatus(`Strong compress done: ${beforeKb} KB -> ${afterKb} KB. Note: pages become images, so text is no longer selectable.`);
    } catch (error) {
      console.error(error);
      setStatus("Strong compress failed on this PDF.");
    } finally {
      setBusy(false);
    }
  };

  const repairPdf = async () => {
    if (!pdfBytes) return;
    setBusy(true);
    try {
      if (engineHas("repair")) {
        setStatus("Repairing and linearizing with the professional engine...");
        const { bytes, report } = await engineProcessPdf("/api/native/repair", {}, null);
        await openPdfBytes(bytes, `${fileName || "repaired"}.pdf`, {});
        setStatus(`Repaired with ${report?.engine || "the engine"} (${report?.action || "rebuild"}) and reopened.`);
        return;
      }
      // NOT ignoreEncryption: pdf-lib has no actual decryption support, so
      // that flag would let an encrypted PDF "load" and then get resaved as
      // a 0-page, unopenable file (confirmed directly - MuPDF reports a
      // corrupt object stream) instead of failing loudly. An encrypted
      // input just isn't repairable this way; say so instead of destroying it.
      const doc = await PDFDocument.load(pdfBytes);
      const bytes = await doc.save({ useObjectStreams: true });
      await openPdfBytes(new Uint8Array(bytes), `${fileName || "repaired"}.pdf`, {});
      setStatus("Rebuilt the PDF structure with the browser engine and reopened the repaired copy.");
    } catch (error) {
      console.error(error);
      setStatus(/encrypted/i.test(error.message || "")
        ? "This PDF is encrypted, so the browser repair engine can't rebuild it. Start the professional engine (`npm.cmd run engine`) and try again."
        : `Repair failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const exportPdfArchiveCopy = async () => {
    if (!pdfBytes) return;
    setBusy(true);
    try {
      if (engineHas("pdfa")) {
        const { report } = await engineProcessPdf(
          "/api/native/pdfa",
          { title: fileName || "Archived document" },
          `${fileName || "document"}-pdfa.pdf`,
        );
        setStatus(report?.linearized
          ? "Saved a normalized, linearized archival copy with the professional engine."
          : "Saved a normalized archival copy with the professional engine.");
        return;
      }
      // NOT ignoreEncryption: pdf-lib can't decrypt content streams, so that
      // flag let copyPages silently copy still-encrypted (garbage) content
      // into the "archival" copy - confirmed every page comes out blank
      // with MuPDF content-stream errors. An archive that doesn't actually
      // preserve the content defeats the point; fail loudly instead.
      const source = await PDFDocument.load(pdfBytes);
      const out = await PDFDocument.create();
      const copied = await out.copyPages(source, source.getPageIndices());
      copied.forEach((page) => out.addPage(page));
      out.setTitle(`${fileName || "document"} archival copy`);
      out.setSubject("Best-effort browser archival rebuild for long-term PDF storage");
      out.setProducer("Local PDF Studio Smart Engine");
      out.setCreator("Local PDF Studio");
      out.setCreationDate(new Date());
      out.setModificationDate(new Date());
      const bytes = await out.save({ useObjectStreams: false, addDefaultPage: false });
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), `${fileName || "document"}-archive.pdf`);
      setStatus("Saved archival PDF rebuild. Note: full certified PDF/A validation still requires a native validator.");
    } catch (error) {
      console.error(error);
      setStatus(/encrypted/i.test(error.message || "")
        ? "This PDF is encrypted, so the browser archival engine can't rebuild it. Start the professional engine (`npm.cmd run engine`) and try again."
        : "Could not create archival PDF copy.");
    } finally {
      setBusy(false);
    }
  };

  const unlockPdfOwnerRestrictions = async () => {
    const source = pdfSourceForTools();
    if (!source) {
      setStatus("Open the PDF first. If it needs an open password, unlock requires a native qpdf-style engine.");
      return;
    }
    const cameFromLockedPdf = !pdfBytes && Boolean(lockedPdf);
    setBusy(true);
    try {
      if (engineHas("unlock")) {
        const { bytes: resultBytes, report } = await engineProcessPdf(
          "/api/native/unlock",
          { password: nativePassword },
          `${source.name || "document"}-unlocked.pdf`,
          "application/pdf",
          source,
        );
        if (cameFromLockedPdf) {
          // This PDF couldn't be opened in the editor at all until now - load
          // the newly-decrypted bytes in, instead of leaving the user with
          // only a downloaded file and a still-empty editor.
          await openPdfBytes(resultBytes, `${source.name || "document"}-unlocked`, {});
          setLockedPdf(null);
        }
        setStatus(report?.wasEncrypted
          ? "Removed encryption and saved an unlocked PDF with the professional engine."
          : "Saved an unlocked (unrestricted) copy with the professional engine.");
        return;
      }
      // NOT ignoreEncryption: pdf-lib cannot actually decrypt PDF content -
      // this whole function's job is exactly encrypted PDFs, which is exactly
      // the case that flag silently destroys (confirmed: resaves as a
      // 0-page file that won't even open, worse than doing nothing). pdf-lib
      // genuinely cannot unlock an encrypted PDF in the browser; say so
      // rather than handing back a broken file that looks like it worked.
      const doc = await PDFDocument.load(source.bytes);
      const bytes = await doc.save({ useObjectStreams: true });
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), `${source.name || "document"}-unlocked.pdf`);
      setStatus("This PDF wasn't actually encrypted, so nothing needed unlocking - saved a clean rebuilt copy anyway.");
    } catch (error) {
      console.error(error);
      if (error.needsPassword) {
        setStatus("This PDF needs its open password. Type it in \"Unlock password\" below, then try Unlock again.");
      } else if (/encrypted/i.test(error.message || "")) {
        setStatus("This PDF is encrypted, and the browser can't actually remove PDF encryption on its own. Start the professional engine (`npm.cmd run engine`) and try Unlock again.");
      } else {
        setStatus(`Unlock failed: ${error.message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  // Character pools for charset brute force - only ever combined with each
  // other via the checkboxes below, never taken from user free-text (that's
  // what dictionary mode's word-list upload is for).
  const CRACK_CHARSETS = {
    lower: "abcdefghijklmnopqrstuvwxyz",
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    digits: "0123456789",
    symbols: "!@#$%^&*()-_=+",
  };

  const crackCharset = () =>
    [
      crackCharsetLower && CRACK_CHARSETS.lower,
      crackCharsetUpper && CRACK_CHARSETS.upper,
      crackCharsetDigits && CRACK_CHARSETS.digits,
      crackCharsetSymbols && CRACK_CHARSETS.symbols,
    ]
      .filter(Boolean)
      .join("");

  // Mirrors engine.py's _crack_candidates() combination count, so the UI can
  // warn before starting a search the server will just reject as too large.
  const crackEstimatedCombos = () => {
    if (crackMode === "pin") {
      let total = 0;
      for (let n = crackMinLen; n <= crackMaxLen; n += 1) total += 10 ** n;
      return total;
    }
    if (crackMode === "charset") {
      const size = crackCharset().length || 0;
      let total = 0;
      for (let n = crackMinLen; n <= crackMaxLen; n += 1) total += size ** n;
      return total;
    }
    return null; // dictionary: size is the word list length, not worth estimating client-side
  };

  const stopCrackPolling = () => {
    if (crackPollRef.current) {
      clearInterval(crackPollRef.current);
      crackPollRef.current = null;
    }
  };

  const pollCrackJob = (jobId) => {
    stopCrackPolling();
    crackPollRef.current = setInterval(async () => {
      let response;
      let data;
      try {
        response = await fetch(`${NATIVE_ENGINE_BASE}/api/native/pdf-crack/status?id=${encodeURIComponent(jobId)}`);
        data = await response.json();
      } catch (error) {
        stopCrackPolling();
        setCrackJob((prev) => (prev ? { ...prev, status: "error", error: error.message } : prev));
        return;
      }
      if (!response.ok) {
        stopCrackPolling();
        setCrackJob((prev) => (prev ? { ...prev, status: "error", error: data.error || "Lost track of the job." } : prev));
        return;
      }
      setCrackJob((prev) => (prev ? { ...prev, ...data } : prev));
      if (data.status === "done" || data.status === "error" || data.status === "cancelled") {
        stopCrackPolling();
        if (data.status === "done" && data.result?.found) {
          setNativePassword(data.result.password);
          setStatus(
            data.result.password === ""
              ? "This PDF has no open password - nothing to recover. Use Unlock PDF for owner restrictions."
              : `Password found: "${data.result.password}". It's filled into "Unlock password" below - click Unlock PDF to remove it.`,
          );
        } else if (data.status === "done") {
          const tried = (data.result?.attempts || 0).toLocaleString();
          setStatus(
            data.result?.reason === "time-limit"
              ? `No match within the time limit (${tried} tried). Try a wider length range, a bigger word list, or start again for more time.`
              : `Searched every combination (${tried} tried) - no match. Try a different mode or a wider range.`,
          );
        } else if (data.status === "cancelled") {
          setStatus("Password recovery cancelled.");
        } else {
          setStatus(`Password recovery failed: ${data.error || "unknown error"}`);
        }
      }
    }, 1000);
  };

  const startPasswordCrack = async () => {
    const source = pdfSourceForTools();
    if (!source) {
      setStatus("Open the PDF first (or pick a file with Open - even a locked one works here).");
      return;
    }
    if (!engineHas("crackPassword")) {
      setStatus("Password recovery needs the professional engine. Start it (`npm.cmd run engine`) and Refresh engine status.");
      return;
    }
    if (crackJob && (crackJob.status === "running" || crackJob.status === "starting")) {
      setStatus("A password recovery job is already running.");
      return;
    }
    if (crackMode === "charset" && !crackCharset()) {
      setStatus("Pick at least one character set for the brute-force search.");
      return;
    }
    const form = new FormData();
    form.append("file", new Blob([source.bytes], { type: "application/pdf" }), `${source.name || "document"}.pdf`);
    form.append("mode", crackMode);
    form.append("minLen", String(crackMinLen));
    form.append("maxLen", String(crackMaxLen));
    if (crackMode === "charset") form.append("charset", crackCharset());
    if (crackMode === "dictionary" && crackWordlistFile) {
      form.append("wordlist", crackWordlistFile, crackWordlistFile.name);
    }
    setCrackJob({ status: "starting", attempts: 0, total: null, elapsedSeconds: 0 });
    setStatus("Starting password recovery...");
    try {
      const response = await fetch(`${NATIVE_ENGINE_BASE}/api/native/pdf-crack/start`, { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) {
        setCrackJob(null);
        setStatus(`Couldn't start password recovery: ${data.error || "unknown error"}`);
        return;
      }
      setCrackJob({ id: data.jobId, status: "running", attempts: 0, total: null, elapsedSeconds: 0 });
      pollCrackJob(data.jobId);
    } catch (error) {
      setCrackJob(null);
      setStatus(`Couldn't start password recovery: ${error.message}`);
    }
  };

  const cancelPasswordCrack = async () => {
    if (!crackJob?.id) return;
    stopCrackPolling();
    try {
      await fetch(`${NATIVE_ENGINE_BASE}/api/native/pdf-crack/cancel?id=${encodeURIComponent(crackJob.id)}`, { method: "POST" });
    } catch {
      // best-effort; the server-side job will still hit its own time cap
    }
    setCrackJob((prev) => (prev ? { ...prev, status: "cancelled" } : prev));
    setStatus("Password recovery cancelled.");
  };

  useEffect(() => () => stopCrackPolling(), []);

  const flattenProtectPdf = async () => {
    if (!pdfDocProxy) return;
    if (engineHas("protect") && !protectPassword.trim()) {
      setStatus("Type a password in \"Protect password\" below to encrypt with real AES-256.");
      return;
    }
    // The browser-only fallback below has no password mechanism at all - it
    // just flattens pages to images. If the user typed a password, they mean
    // for the file to actually require it to open; silently dropping that
    // password and shipping an unprotected file would be a false sense of
    // security worse than no password field existing at all.
    if (!engineHas("protect") && protectPassword.trim()) {
      setStatus("That password can't be applied without the professional engine - a browser-only flattened copy has no password protection at all. Run `npm.cmd run engine`, click Refresh engine status, then Protect again. To make an unprotected flattened copy on purpose, clear the password field first.");
      return;
    }
    setBusy(true);
    try {
      if (engineHas("protect") && protectPassword.trim()) {
        await engineProcessPdf(
          "/api/native/protect",
          { password: protectPassword.trim() },
          `${fileName || "document"}-protected.pdf`,
        );
        setStatus("Saved a real AES-256 password-protected PDF with the professional engine.");
        return;
      }
      const out = await PDFDocument.create();
      for (let index = 1; index <= pageCount; index += 1) {
        const page = await pdfDocProxy.getPage(index);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
        const image = await out.embedJpg(await blob.arrayBuffer());
        const outPage = out.addPage([viewport.width / 2, viewport.height / 2]);
        outPage.drawImage(image, { x: 0, y: 0, width: viewport.width / 2, height: viewport.height / 2 });
        setStatus(`Protect engine: flattening page ${index} / ${pageCount}...`);
      }
      out.setTitle(`${fileName || "document"} protected copy`);
      out.setProducer("Local PDF Studio Smart Engine");
      const bytes = await out.save({ useObjectStreams: true });
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), `${fileName || "document"}-protected-flat.pdf`);
      setStatus("Saved a flattened protected copy with the browser engine. Start the professional engine for real AES-256 password encryption.");
    } catch (error) {
      console.error(error);
      setStatus("Could not create protected flattened copy.");
    } finally {
      setBusy(false);
    }
  };

  const addPageNumbers = () => {
    if (!pageCount) return;
    pushHistory();
    const numbers = Array.from({ length: pageCount }, (_, index) => ({
      id: uid(),
      page: index + 1,
      type: "text",
      x: 0.82,
      y: 0.955,
      w: 0.14,
      h: 0.03,
      text: `${index + 1} / ${pageCount}`,
      color: "#111827",
      fontSize: 11,
      fontFamily: "helvetica",
      align: "right",
      opacity: 0.8,
    }));
    setAnnotations((items) => [...items, ...numbers]);
    setStatus("Page numbers added. Export to burn them into the PDF.");
  };

  // Real page-aligned, word-level diff on the professional engine: pages are
  // matched up correctly even when some were inserted/deleted/reordered (not
  // assumed 1:1 by page number), and within each changed page pair the exact
  // words that were added/removed come back with their positions - the
  // output is a visual diff PDF with every changed page shown twice
  // (original with removed words boxed red, new version with added words
  // boxed green). Falls back to a plain bag-of-words text report - no order,
  // no position, no way to tell "one word changed" from "the whole page
  // changed" - only when the engine isn't running, and says so.
  const comparePdf = async (file) => {
    if (!pdfDocProxy || !pdfBytes || !file) return;
    setBusy(true);
    try {
      if (engineHas("compare")) {
        setStatus("Comparing on the professional engine (page alignment + word-level diff)...");
        const form = new FormData();
        form.append("fileA", new Blob([pdfBytes], { type: "application/pdf" }), `${fileName || "current"}.pdf`);
        form.append("fileB", file, file.name);
        const { bytes, report } = await nativePdfRequest("/api/native/compare", form);
        downloadBlob(new Blob([bytes], { type: "application/pdf" }), `${fileName || "document"}-compare.pdf`);
        if (report?.identical) {
          setStatus("These documents are textually identical - no differences found.");
        } else {
          const parts = [];
          if (report?.pagesModified) parts.push(`${report.pagesModified} page(s) edited`);
          if (report?.pagesInserted) parts.push(`${report.pagesInserted} new page(s)`);
          if (report?.pagesDeleted) parts.push(`${report.pagesDeleted} removed page(s)`);
          setStatus(`Compared: ${parts.join(", ")} - ${report?.wordsRemoved ?? 0} word(s) removed, ${report?.wordsAdded ?? 0} added. Downloaded a visual diff PDF: each changed page appears as before/after with the exact words boxed.`);
        }
        return;
      }
      const currentText = await getPdfPlainText();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const other = await pdfjsLib.getDocument({ data: bytes }).promise;
      const otherSections = [];
      for (let index = 1; index <= other.numPages; index += 1) {
        const page = await other.getPage(index);
        const text = await page.getTextContent();
        otherSections.push(text.items.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim());
      }
      const otherText = otherSections.join("\n");
      const currentWords = new Set(currentText.toLowerCase().split(/\W+/).filter(Boolean));
      const otherWords = new Set(otherText.toLowerCase().split(/\W+/).filter(Boolean));
      const onlyCurrent = [...currentWords].filter((word) => !otherWords.has(word)).slice(0, 300);
      const onlyOther = [...otherWords].filter((word) => !currentWords.has(word)).slice(0, 300);
      const report = [
        `Compare report: ${fileName || "current"} vs ${file.name}`,
        `(Browser fallback - a plain word-difference, not a real page/word-aligned diff. Start the professional engine for that.)`,
        "",
        `Current pages: ${pageCount}`,
        `Other pages: ${other.numPages}`,
        "",
        "Words only in current PDF:",
        onlyCurrent.join(", ") || "None detected",
        "",
        "Words only in compared PDF:",
        onlyOther.join(", ") || "None detected",
      ].join("\n");
      downloadBlob(new Blob([report], { type: "text/plain;charset=utf-8" }), `${fileName || "document"}-compare.txt`);
      setStatus("Compared PDFs with the browser fallback and downloaded a text report. Start the professional engine for a real page-aligned, word-level visual diff.");
    } catch (error) {
      console.error(error);
      setStatus(`Could not compare that PDF: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  // Real local document intelligence (TextRank extractive summary + keyword
  // and entity extraction + readability) - runs entirely on this server,
  // no AI API key needed. This used to require the user's own paid API key
  // via askAiGuide, which meant "AI Summarizer" was unusable to exactly the
  // people a free tool is for. The free-form "Ask AI" panel (own API key)
  // stays available separately for open-ended questions and translation.
  const summarizeDocument = async () => {
    if (!pdfBytes) {
      setStatus("Open a PDF first, then summarize it.");
      return;
    }
    if (!engineHas("summarize")) {
      setStatus("Summarizer needs the professional engine. Run `npm.cmd run engine`, then Refresh engine status - or use the \"Ask AI\" panel below with your own API key instead.");
      return;
    }
    setBusy(true);
    setAiAnswer("Reading the document and finding its key sentences...");
    try {
      const form = new FormData();
      form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), `${fileName || "document"}.pdf`);
      const response = await fetch(`${NATIVE_ENGINE_BASE}/api/native/summarize`, { method: "POST", body: form });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || `Summarizer failed (${response.status})`);
      }
      const result = await response.json();
      if (result.empty) {
        setAiAnswer("No extractable text was found on this document. If it's a scan, run OCR first.");
        setStatus("Nothing to summarize.");
        return;
      }
      const e = result.entities || {};
      const facts = [];
      if (e.dates?.length) facts.push(`Dates: ${e.dates.join(", ")}`);
      if (e.amounts?.length) facts.push(`Amounts: ${e.amounts.join(", ")}`);
      if (e.percentages?.length) facts.push(`Percentages: ${e.percentages.join(", ")}`);
      if (e.emails?.length) facts.push(`Emails: ${e.emails.join(", ")}`);
      const r = result.readability || {};
      const text = [
        "DOCUMENT SUMMARY (local engine, no AI key used)",
        "",
        result.summary || "(no summary sentences found)",
        "",
        `KEY FACTS FOUND${facts.length ? "" : ": none detected"}`,
        ...facts,
        "",
        `TOP KEYWORDS: ${(result.keywords || []).slice(0, 10).map((k) => k.term).join(", ") || "none"}`,
        "",
        `READABILITY: ${r.level || "n/a"} (Flesch ${r.fleschScore ?? "?"}) - ${r.wordCount ?? "?"} words, ~${r.readingTimeMinutes ?? "?"} min read`,
      ].join("\n");
      setAiAnswer(text);
      setStatus(`Summarized ${result.sentenceCount} sentence(s) down to ${result.sentences?.length ?? 0} key sentence(s), entirely on this server.`);
    } catch (error) {
      console.error(error);
      setAiAnswer(`Summarizer failed: ${error.message}`);
      setStatus("Could not summarize this document.");
    } finally {
      setBusy(false);
    }
  };

  const rememberAiSettings = () => {
    sessionStorage.setItem("pdfStudioApiBase", apiBase);
    sessionStorage.setItem("pdfStudioApiKey", apiKey);
    sessionStorage.setItem("pdfStudioApiModel", apiModel);
    setStatus("AI/API settings saved for this browser session only.");
  };

  const testAiConnection = async () => {
    if (!apiKey.trim()) {
      setAiAnswer("Paste an API key first, then Test connection.");
      return;
    }
    setBusy(true);
    setAiAnswer("Testing connection and listing your available models...");
    try {
      rememberAiSettings();
      const models = await listModels({ provider: inferProvider(apiBase), base: apiBase, key: apiKey });
      if (!models.length) {
        setAiAnswer("Connected, but the provider returned no model list. Your key works — type a model name manually.");
      } else {
        const match = models.includes(apiModel) ? "" : `\n\nNote: "${apiModel}" is NOT in this list — copy one of the IDs above into the Model box.`;
        setAiAnswer(`Connected! Models your key can use:\n\n${models.map((m) => `• ${m}`).join("\n")}${match}`);
      }
      setStatus("AI connection OK.");
    } catch (error) {
      console.error(error);
      setAiAnswer(`Connection test failed: ${error.message}`);
      setStatus("AI connection failed.");
    } finally {
      setBusy(false);
    }
  };

  // "guide" answers "how do I do X in this app"; "document" actually performs
  // the requested task (summarize/translate) against the document's own text.
  // These need different system prompts - a guide prompt told to "recommend
  // tools" will happily answer "use the summarize feature" instead of
  // actually summarizing, which is what AI Summarizer/Translate PDF promise.
  const AI_GUIDE_SYSTEM =
    "You are a PDF Studio guide. Recommend exact tools and concise steps. Do not ask for secrets. Available tools: merge, split, remove pages, extract pages, organize, scan/image to PDF, compress, repair, OCR, JPG/Word/HTML/text to PDF, PDF to text/DOCX/PNG, rotate, page numbers, watermark, crop, edit text, forms, sign, redact, compare, summarize, translate.";
  const AI_DOCUMENT_SYSTEM =
    "You are a document assistant. Read the provided PDF text sample and directly perform the requested task (summarizing or translating the actual content). Do not recommend app tools or features - the user already has the document open and wants the real output. If the text sample is marked as truncated/incomplete, say so plainly in your answer instead of presenting a partial result as if it covers the whole document.";

  const askAiGuide = async (task = aiPrompt, mode = "guide") => {
    if (!apiKey.trim()) {
      setAiAnswer("Paste an API key first. It is stored only in this browser session.");
      return;
    }
    setBusy(true);
    setAiAnswer(mode === "document" ? "Reading the document..." : "Thinking...");
    try {
      rememberAiSettings();
      const fullText = pdfDocProxy ? await getPdfPlainText() : "";
      const SAMPLE_LIMIT = 12000;
      const docText = fullText.slice(0, SAMPLE_LIMIT);
      const truncNote = fullText.length > SAMPLE_LIMIT
        ? `\n\n[NOTE TO MODEL: this sample is only the first ${SAMPLE_LIMIT} of ${fullText.length} extracted characters from a ${pageCount}-page document - it is INCOMPLETE. Tell the user this result only covers part of the document.]`
        : "";
      const answer = await callAi({
        provider: inferProvider(apiBase),
        base: apiBase,
        key: apiKey,
        model: apiModel,
        system: mode === "document" ? AI_DOCUMENT_SYSTEM : AI_GUIDE_SYSTEM,
        prompt: `Task: ${task}\nCurrent document: ${fileName || "none"}\nPages: ${pageCount || 0}\nSelected page: ${pageNumber}\nDetected text fragments on current page: ${pageTextItems.length}\nVisible status: ${status}\nPDF text sample:\n${docText}${truncNote}`,
      });
      setAiAnswer(answer || "No answer returned.");
      setStatus(mode === "document" ? "AI finished working on the document." : "AI guide answered.");
    } catch (error) {
      console.error(error);
      setAiAnswer(`AI request failed: ${error.message}`);
      setStatus("AI guide request failed.");
    } finally {
      setBusy(false);
    }
  };

  const toolBadge = (id) => {
    const feature = TOOL_ENGINE_FEATURE[id];
    if (!feature) return { label: "works", tone: "works", title: "Runs fully in your browser." };
    if (engineHas(feature)) return { label: "pro", tone: "pro", title: "Powered by the professional engine." };
    if (ENGINE_REQUIRED_TOOLS.has(id)) {
      return { label: "engine", tone: "needs", title: "Needs the professional engine. Run `npm.cmd run engine`." };
    }
    return { label: "browser", tone: "browser", title: "Engine is off; using the built-in browser fallback." };
  };

  const handleToolCenterAction = (id) => {
    const needPdf = () => {
      if (!pdfBytes) {
        setStatus("Open a PDF first, then use this tool.");
        return true;
      }
      return false;
    };
    const unsupported = (name, detail) => setStatus(`${name}: ${detail}`);
    switch (id) {
      case "merge":
        mergeRef.current?.click();
        break;
      case "split":
        splitPdf();
        break;
      case "remove":
        deleteCurrentPage();
        break;
      case "extract":
        exportPageRange();
        break;
      case "organize":
        setStatus("Use Move up, Move down, Duplicate page, Delete page, and Extract in the Pages panel.");
        break;
      case "scan":
      case "jpgToPdf":
      case "wordToPdf":
      case "htmlToPdf":
        convertRef.current?.click();
        break;
      case "pptToPdf":
        convertRef.current?.click();
        break;
      case "excelToPdf":
        convertRef.current?.click();
        break;
      case "compress":
        compressPdf();
        break;
      case "compressStrong":
        compressPdfStrong();
        break;
      case "photoStudio":
        openPhoto(null);
        break;
      case "passportPhoto":
        openPhoto("in-passport");
        break;
      case "govtPhoto":
        openPhoto("govt-photo");
        break;
      case "repair":
        repairPdf();
        break;
      case "ocr":
        ocrPdfSearchable();
        break;
      case "pdfToJpg":
        exportAllPagesPngZip("jpg");
        break;
      case "pdfToWord":
        exportPdfAsDocx();
        break;
      case "pdfToPpt":
        exportPdfAsPptx();
        break;
      case "pdfToExcel":
        exportPdfAsXlsx();
        break;
      case "pdfToPdfA":
        exportPdfArchiveCopy();
        break;
      case "rotate":
        rotatePage();
        break;
      case "pageNumbers":
        addPageNumbers();
        break;
      case "watermark":
        applyWatermark();
        break;
      case "crop":
        cropCurrentPageToSelection();
        break;
      case "edit":
        setTool("editText");
        setStatus("Edit PDF mode enabled. Click detected text or use Make Editable.");
        break;
      case "forms":
        setTool("text");
        setStatus("Form tools ready: use Text for fields, Check for checkboxes, Stamp/Signature for approvals.");
        break;
      case "unlock":
        unlockPdfOwnerRestrictions();
        break;
      case "crackPassword":
        startPasswordCrack();
        break;
      case "protect":
        flattenProtectPdf();
        break;
      case "removeWatermark":
        removeWatermark();
        break;
      case "sign":
        setTool("signature");
        setStatus("Signature tool selected. Draw your signature on the page.");
        break;
      case "redact":
        setTool("redact");
        setStatus(engineHas("redactRegions")
          ? "Redact tool selected. Draw boxes over content, then export - the covered content is permanently removed, not just covered."
          : "Redact tool selected. Draw boxes over content, then export. Needs the professional engine running to permanently remove what's covered (not just paint over it) - start it with `npm.cmd run engine`.");
        break;
      case "compare":
        compareRef.current?.click();
        break;
      case "summarize":
        summarizeDocument();
        break;
      case "translate":
        askAiGuide("Translate this document's actual text into English (state that a different target language can be requested if the current text isn't already English).", "document");
        break;
      default:
        if (!needPdf()) setStatus("Tool selected.");
    }
  };

  const createBlankPdf = async () => {
    const doc = await PDFDocument.create();
    doc.addPage([PAPER.width, PAPER.height]);
    const bytes = await doc.save();
    await openPdfBytes(new Uint8Array(bytes), "Blank document.pdf", {});
  };

  const reloadEditedBytes = async (bytes, message) => {
    await openPdfBytes(new Uint8Array(bytes), `${fileName || "document"}.pdf`, { keepAnnotations: true, keepHistory: true });
    setStatus(message);
  };

  const insertBlankPage = async () => {
    if (!pdfBytes) return;
    setBusy(true);
    try {
      const doc = await PDFDocument.load(pdfBytes);
      const size = doc.getPage(pageNumber - 1)?.getSize() || PAPER;
      const { bytes, annotations: nextAnns } = await opsInsertBlank(
        pdfBytes, annotations, pageNumber, pageCount, [size.width, size.height]);
      setAnnotations(nextAnns);
      await reloadEditedBytes(bytes, `Inserted a blank page after page ${pageNumber}.`);
      setPageNumber(pageNumber + 1);
      setStatus("Blank page inserted. Use Go to page 1 if you meant to edit the original PDF content.");
    } catch (error) {
      console.error(error);
      setStatus(error.message?.includes("security restrictions") ? error.message : "Could not insert a blank page.");
    } finally {
      setBusy(false);
    }
  };

  const deleteCurrentPage = async () => {
    if (!pdfBytes) return;
    if (pageCount <= 1) {
      setStatus("Can't delete the only page in the document.");
      return;
    }
    setBusy(true);
    try {
      const { bytes, annotations: nextAnns } = await opsDeletePage(
        pdfBytes, annotations, pageNumber, pageCount);
      setAnnotations(nextAnns);
      await reloadEditedBytes(bytes, `Deleted page ${pageNumber}.`);
      setPageNumber((page) => Math.min(page, pageCount - 1));
    } catch (error) {
      console.error(error);
      // The pageCount<=1 check above already prevents this in the normal
      // flow, but deletePage() itself also refuses now (defense in depth
      // for any other caller) - forward that message too if it's ever
      // reached, e.g. via stale pageCount state.
      setStatus(error.message?.includes("security restrictions") || error.message?.includes("only page")
        ? error.message
        : "Could not delete that page.");
    } finally {
      setBusy(false);
    }
  };

  const duplicateCurrentPage = async () => {
    if (!pdfBytes) return;
    setBusy(true);
    try {
      const { bytes, annotations: nextAnns } = await opsDuplicatePage(
        pdfBytes, annotations, pageNumber, pageCount, uid);
      setAnnotations(nextAnns);
      await reloadEditedBytes(bytes, `Duplicated page ${pageNumber}.`);
      setPageNumber(pageNumber + 1);
    } catch (error) {
      console.error(error);
      setStatus(error.message?.includes("security restrictions") ? error.message : "Could not duplicate that page.");
    } finally {
      setBusy(false);
    }
  };

  const moveCurrentPage = async (direction) => {
    if (!pdfBytes) return;
    const target = pageNumber + direction;
    if (target < 1 || target > pageCount) return;
    setBusy(true);
    try {
      const { bytes, annotations: nextAnns } = await opsMovePage(
        pdfBytes, annotations, pageNumber, target, pageCount);
      setAnnotations(nextAnns);
      await reloadEditedBytes(bytes, `Moved page ${pageNumber} ${direction < 0 ? "up" : "down"}.`);
      setPageNumber(target);
    } catch (error) {
      console.error(error);
      setStatus(error.message?.includes("security restrictions") ? error.message : "Could not move that page.");
    } finally {
      setBusy(false);
    }
  };

  const mergePdf = async (file) => {
    if (!pdfBytes || !file) return;
    setBusy(true);
    try {
      const incomingBytes = new Uint8Array(await file.arrayBuffer());
      // Same tested code path as multi-file Open (src/lib/pdfMerge.js).
      const bytes = await mergePdfBytes([pdfBytes, incomingBytes], [fileName ? `${fileName}.pdf` : "the open document", file.name]);
      await reloadEditedBytes(bytes, `Merged ${file.name} at the end of this PDF.`);
    } catch (error) {
      console.error(error);
      setStatus(error.message?.includes("password-protected") || error.message?.includes("could not be read")
        ? error.message
        : "Could not merge that PDF. It may be encrypted or damaged.");
    } finally {
      setBusy(false);
    }
  };

  const exportPageRange = async () => {
    if (!pdfBytes) return;
    const pages = parsePageRange(rangeText, pageCount);
    if (!pages.length) {
      setStatus("Enter a page range like 1-3, 5.");
      return;
    }
    setBusy(true);
    try {
      const source = await PDFDocument.load(pdfBytes);
      const next = await PDFDocument.create();
      const copied = await next.copyPages(source, pages);
      copied.forEach((page) => next.addPage(page));
      const bytes = await next.save();
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), `${fileName || "document"}-pages-${rangeText}.pdf`);
      setStatus("Extracted the selected page range.");
    } catch (error) {
      console.error(error);
      setStatus("Could not extract that page range.");
    } finally {
      setBusy(false);
    }
  };

  const splitPdf = async () => {
    if (!pdfBytes) return;
    setBusy(true);
    try {
      const source = await PDFDocument.load(pdfBytes);
      const zip = new JSZip();
      for (let index = 0; index < source.getPageCount(); index += 1) {
        const one = await PDFDocument.create();
        const [page] = await one.copyPages(source, [index]);
        one.addPage(page);
        const bytes = await one.save();
        zip.file(`${fileName || "document"}-page-${String(index + 1).padStart(3, "0")}.pdf`, bytes);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      downloadBlob(blob, `${fileName || "document"}-split-pages.zip`);
      setStatus("Split the PDF into one file per page.");
    } catch (error) {
      console.error(error);
      setStatus("Could not split this PDF.");
    } finally {
      setBusy(false);
    }
  };

  const applyWatermark = () => {
    if (!pageCount || !watermarkText.trim()) return;
    pushHistory();
    const marks = Array.from({ length: pageCount }, (_, index) => ({
      id: uid(),
      page: index + 1,
      type: "watermark",
      x: 0.12,
      y: 0.43,
      w: 0.76,
      h: 0.12,
      text: watermarkText,
      color: inkColor,
      fontSize: 44,
      fontFamily,
      bold: textBold,
      italic: textItalic,
      underline: textUnderline,
      align: "center",
      opacity: 0.16,
    }));
    setAnnotations((items) => [...items, ...marks]);
    setStatus(`Added "${watermarkText}" watermark to every page.`);
  };

  const exportPdf = async () => {
    if (!pdfBytes) return;
    setBusy(true);
    setStatus("Writing edits into a new PDF...");
    try {
      // Redact AND eraser boxes both need to ACTUALLY remove the covered
      // text/images, not just paint over them - a rectangle drawn on top by
      // pdf-lib leaves the original content fully intact and
      // copy/extractable underneath it. Real removal needs PyMuPDF's
      // redaction machinery, so run both through it in one pass (black fill
      // for redact, white for erase) and use its output as the base
      // document; the pdf-lib loop below then draws every other annotation
      // on top of it.
      let baseBytes = pdfBytes;
      const removalAnnotations = annotations.filter((item) => item.type === "redact" || item.type === "eraser");
      if (removalAnnotations.length) {
        if (!engineHas("redactRegions")) {
          setStatus("Redact/Eraser need the professional engine to permanently remove the covered content (a painted box alone would leave the original text recoverable). Run `npm.cmd run engine`, click Refresh engine status, then export again.");
          setBusy(false);
          return;
        }
        const regions = removalAnnotations.map((item) => ({
          page: item.page - 1,
          rect: [item.x, item.y, item.x + item.w, item.y + item.h],
          fill: item.type === "eraser" ? "white" : "black",
        }));
        const form = new FormData();
        form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), `${fileName || "document"}.pdf`);
        form.append("regions", JSON.stringify(regions));
        const { bytes: redactedBytes } = await nativePdfRequest("/api/native/redact-regions", form);
        baseBytes = redactedBytes;
      }
      const doc = await PDFDocument.load(baseBytes);
      const fonts = {
        helvetica: {
          regular: await doc.embedFont(StandardFonts.Helvetica),
          bold: await doc.embedFont(StandardFonts.HelveticaBold),
          italic: await doc.embedFont(StandardFonts.HelveticaOblique),
          boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
        },
        times: {
          regular: await doc.embedFont(StandardFonts.TimesRoman),
          bold: await doc.embedFont(StandardFonts.TimesRomanBold),
          italic: await doc.embedFont(StandardFonts.TimesRomanItalic),
          boldItalic: await doc.embedFont(StandardFonts.TimesRomanBoldItalic),
        },
        courier: {
          regular: await doc.embedFont(StandardFonts.Courier),
          bold: await doc.embedFont(StandardFonts.CourierBold),
          italic: await doc.embedFont(StandardFonts.CourierOblique),
          boldItalic: await doc.embedFont(StandardFonts.CourierBoldOblique),
        },
      };
      const skippedAnnotations = [];
      for (const annotation of annotations) {
       try {
        const page = doc.getPage(annotation.page - 1);
        const size = page.getSize();
        if (annotation.type === "rotate") {
          const current = page.getRotation().angle || 0;
          page.setRotation(degrees((current + annotation.degrees) % 360));
          continue;
        }
        if (annotation.points) {
          // Same Ramer-Douglas-Peucker + centripetal Catmull-Rom smoothing as
          // the live preview (src/lib/smoothPath.js), so the exported stroke
          // matches what was actually drawn on screen instead of the raw,
          // jagged pointer samples - pdf-lib only draws straight segments, so
          // "smooth" here means many short segments along the same curve.
          const smoothed = smoothPoints(annotation.points);
          for (let i = 1; i < smoothed.length; i += 1) {
            const a = toPdfPoint(smoothed[i - 1].x, smoothed[i - 1].y, size);
            const b = toPdfPoint(smoothed[i].x, smoothed[i].y, size);
            page.drawLine({
              start: a,
              end: b,
              thickness: annotation.width || 2,
              color: hexToRgb(annotation.color),
              opacity: annotation.opacity ?? 0.95,
            });
          }
          continue;
        }
        const pdfBox = toPdfBox(annotation, size);
        const { x, y, width: w, height: h } = pdfBox;
        if (annotation.type === "textEdit" && annotation.coverOriginal) {
          const coverPad = annotation.coverPad ?? 1.5;
          page.drawRectangle({
            x: x - coverPad,
            y: y - coverPad,
            width: w + coverPad * 2,
            height: h + coverPad * 2,
            color: hexToRgb(annotation.coverColor || "#ffffff"),
            opacity: 1,
          });
        }
        // A "text" box left at its placeholder ("Type here" shown via CSS,
        // never actually typed into - annotation.text stays "") draws
        // nothing at all, rather than exporting an empty text object.
        if ((annotation.type === "text" && annotation.text?.trim()) || annotation.type === "textEdit" || annotation.type === "watermark") {
          await drawTextSafely(doc, page, annotation, { x, y, width: w, height: h }, fonts);
        }
        if (annotation.type === "note") {
          page.drawRectangle({
            x,
            y,
            width: w,
            height: h,
            color: hexToRgb(annotation.fill || "#fef3c7"),
            opacity: annotation.opacity ?? 0.96,
            borderColor: rgb(0.84, 0.61, 0.16),
            borderWidth: 1,
          });
          if (annotation.text?.trim()) {
            await drawTextSafely(doc, page, annotation, { x: x + 8, y: y + 8, width: Math.max(1, w - 16), height: Math.max(1, h - 16) }, fonts);
          }
        }
        if (annotation.type === "highlight") {
          page.drawRectangle({ x, y, width: w, height: h, color: hexToRgb(annotation.color), opacity: annotation.opacity ?? 0.34 });
        }
        if (annotation.type === "rectangle") {
          page.drawRectangle({
            x,
            y,
            width: w,
            height: h,
            borderColor: hexToRgb(annotation.color || "#111827"),
            borderWidth: annotation.width || 2,
            borderOpacity: annotation.opacity ?? 1,
            opacity: 0,
          });
        }
        if (annotation.type === "ellipse") {
          page.drawEllipse({
            x: x + w / 2,
            y: y + h / 2,
            xScale: Math.max(1, w / 2),
            yScale: Math.max(1, h / 2),
            borderColor: hexToRgb(annotation.color || "#111827"),
            borderWidth: annotation.width || 2,
            borderOpacity: annotation.opacity ?? 1,
          });
        }
        if (annotation.type === "line" || annotation.type === "arrow") {
          const color = hexToRgb(annotation.color || "#111827");
          const thickness = annotation.width || 2;
          const { start, end } = toPdfLineEndpoints(annotation, size);
          page.drawLine({
            start,
            end,
            thickness,
            color,
            opacity: annotation.opacity ?? 1,
          });
          if (annotation.type === "arrow") drawArrowHead(page, start, end, color, thickness, annotation.opacity ?? 1);
        }
        if (annotation.type === "check") {
          const color = hexToRgb(annotation.color || "#111827");
          const thickness = annotation.width || 3;
          const a = { x: x + w * 0.12, y: y + h * 0.45 };
          const b = { x: x + w * 0.38, y: y + h * 0.16 };
          const c = { x: x + w * 0.88, y: y + h * 0.82 };
          page.drawLine({ start: a, end: b, thickness, color, opacity: annotation.opacity ?? 1 });
          page.drawLine({ start: b, end: c, thickness, color, opacity: annotation.opacity ?? 1 });
        }
        if (annotation.type === "redact") {
          // The actual content under this box was already permanently removed
          // by the engine (see the redaction pre-pass above export loads the
          // document) - this just paints the same black fill the engine used,
          // so the page looks identical whether or not this branch runs.
          page.drawRectangle({ x, y, width: w, height: h, color: rgb(0.02, 0.02, 0.02), opacity: 1 });
        }
        if (annotation.type === "eraser") {
          // Same idea as redact just above, but the engine already filled
          // this region white (see the removal pre-pass), so this is purely
          // cosmetic redundancy for consistency, not the actual erase.
          page.drawRectangle({ x, y, width: w, height: h, color: rgb(1, 1, 1), opacity: 1 });
        }
        if (annotation.type === "image" && annotation.dataUrl) {
          const imageBytes = dataUrlToBytes(annotation.dataUrl);
          const image = annotation.mimeType?.includes("png")
            ? await doc.embedPng(imageBytes)
            : await doc.embedJpg(imageBytes);
          page.drawImage(image, { x, y, width: w, height: h, opacity: annotation.opacity ?? 1 });
        }
        if (annotation.type === "stamp") {
          page.drawRectangle({
            x,
            y,
            width: w,
            height: h,
            borderColor: hexToRgb(annotation.color || "#111827"),
            borderWidth: annotation.width || 2,
            borderOpacity: annotation.opacity ?? 1,
            opacity: 0,
          });
          try {
            page.drawText(annotation.text || "APPROVED", {
              x: x + 10,
              y: y + h / 2 - 7,
              size: 16,
              font: fonts.helvetica.bold,
              color: hexToRgb(annotation.color || "#111827"),
              maxWidth: Math.max(1, w - 20),
              opacity: annotation.opacity ?? 1,
            });
          } catch (error) {
            console.warn("Stamp text failed, rendering as an image instead:", error.message);
            await drawTextSafely(doc, page, { ...annotation, text: annotation.text || "APPROVED", bold: true, fontSize: 16 },
              { x: x + 10, y: y + h / 2 - 12, width: Math.max(1, w - 20), height: 16 }, fonts);
          }
        }
       } catch (error) {
        // One malformed/unsupported annotation must not silently take every
        // OTHER edit on the document down with it - confirmed this was
        // happening: a single non-Latin-script text/watermark annotation
        // threw inside this loop, which was caught by the outer try/catch,
        // which meant doc.save() never ran and NOTHING downloaded at all,
        // with a generic "Export failed" message that didn't explain why.
        console.error(`Skipping annotation on page ${annotation.page} (${annotation.type}):`, error);
        skippedAnnotations.push(annotation);
       }
      }
      const edited = await doc.save();
      downloadBlob(new Blob([edited], { type: "application/pdf" }), `${fileName || "edited"}-edited.pdf`);
      setStatus(skippedAnnotations.length
        ? `Export complete, but ${skippedAnnotations.length} annotation(s) could not be applied and were skipped (check the browser console for details). Your original file was not changed.`
        : "Export complete. Your original file was not changed.");
    } catch (error) {
      console.error(error);
      setStatus(`Export failed: ${error.message || "the PDF may be encrypted or structurally invalid."}`);
    } finally {
      setBusy(false);
    }
  };

  const annotationStyle = (item) => ({
    left: `${item.x * 100}%`,
    top: `${item.y * 100}%`,
    width: `${item.w * 100}%`,
    height: `${item.h * 100}%`,
    color: item.color,
    borderColor: item.color,
    opacity: item.opacity ?? 1,
    "--stroke-width": `${item.width || 2}px`,
    fontSize: item.fontSize ? `${item.fontSize * (item.type === "textEdit" || item.detectedFontName === "OCR" ? zoom : 1)}px` : undefined,
    fontFamily: item.fontFamily ? getCssFont(item.fontFamily) : undefined,
    fontWeight: item.bold ? 800 : undefined,
    fontStyle: item.italic ? "italic" : undefined,
    textDecoration: item.underline ? "underline" : undefined,
    textAlign: item.align || undefined,
    backgroundColor: item.type === "note" ? item.fill || "#fef3c7" : item.type === "textEdit" ? item.coverColor || "#ffffff" : undefined,
  });

  const openPhoto = (preset) => {
    setPhotoPreset(preset);
    paperSound.playFlip();
    setStudio("photo");
  };

  return (
    <PaperShell>
      {studio === "photo" ? (
        <PhotoStudio onBack={() => { paperSound.playFlip(); setStudio("pdf"); }} initialPresetId={photoPreset} />
      ) : (
    <main
      className="app-shell"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        loadPdf(event.dataTransfer.files?.[0]);
      }}
    >
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><BadgeCheck size={18} /></div>
          <div>
            <strong>Local PDF Studio</strong>
            <span>{fileName ? `${fileName}.pdf` : "Private browser-based editor"}</span>
          </div>
        </div>
        <div className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") searchPdf(); }}
            placeholder="Find text"
          />
          <button onClick={searchPdf} disabled={!pdfDocProxy || busy}>Find</button>
          {matches.length > 0 && (
            <div className="search-nav">
              <span>{matchIndex + 1}/{matches.length}</span>
              <button onClick={() => gotoMatch(-1)} disabled={busy} title="Previous match" aria-label="Previous match"><ChevronLeft size={15} /></button>
              <button onClick={() => gotoMatch(1)} disabled={busy} title="Next match" aria-label="Next match"><ChevronRight size={15} /></button>
            </div>
          )}
        </div>
        <div className="top-actions">
          <button onClick={createBlankPdf} className="ghost"><FilePlus2 size={17} />New</button>
          <button onClick={() => fileRef.current?.click()} className="ghost"><Upload size={17} />Open</button>
          <button onClick={() => convertRef.current?.click()} disabled={busy} className="ghost"><FileInput size={17} />Convert</button>
          <button onClick={() => mergeRef.current?.click()} disabled={!pdfBytes || busy} className="ghost"><FileInput size={17} />Merge</button>
          <button onClick={() => openPhoto(null)} className="ghost"><Crop size={17} />Photo Studio</button>
          <button onClick={exportPdf} disabled={!pdfBytes || busy} className="primary"><Save size={17} />Export</button>
          <input ref={fileRef} className="file-input" type="file" accept="application/pdf" multiple onChange={(event) => { openPdfFiles(event.target.files); event.target.value = ""; }} />
          <input ref={mergeRef} className="file-input" type="file" accept="application/pdf" onChange={(event) => mergePdf(event.target.files?.[0])} />
          <input ref={compareRef} className="file-input" type="file" accept="application/pdf" onChange={(event) => comparePdf(event.target.files?.[0])} />
          <input
            ref={convertRef}
            className="file-input"
            type="file"
            multiple
            accept=".pdf,.docx,.xlsx,.xls,.pptx,.ppt,.txt,.csv,.md,.log,.html,.htm,image/png,image/jpeg,text/plain,text/csv,text/html,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint"
            onChange={(event) => {
              convertFilesToPdf(event.target.files);
              event.target.value = "";
            }}
          />
          <input
            ref={imageRef}
            className="file-input"
            type="file"
            accept="image/png,image/jpeg"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const dataUrl = await fileToDataUrl(file);
              const aspect = await getImageAspect(dataUrl);
              setPendingImage({ dataUrl, mimeType: file.type, aspect });
              setTool("image");
              setStatus(`${file.name} ready. Click the page to place it.`);
            }}
          />
        </div>
      </header>

      <aside className="page-rail">
        <div className="rail-title">Pages</div>
        {pageCount ? (
          Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
            <button
              key={page}
              className={`page-chip ${page === pageNumber ? "active" : ""} ${matches.includes(page) ? "match" : ""} ${thumbs[page] ? "has-thumb" : ""}`}
              onClick={() => setPageNumber(page)}
            >
              {thumbs[page] && <img src={thumbs[page]} alt="" draggable={false} />}
              <span>{page}</span>
              <small>{annotations.filter((item) => item.page === page && item.type !== "rotate").length || ""}</small>
            </button>
          ))
        ) : (
          <div className="empty-rail">
            <Upload size={28} />
            <span>Open or drop a PDF</span>
          </div>
        )}
      </aside>

      <section className="workspace">
        <nav className="toolstrip">
          {TOOLS.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                className={tool === entry.id ? "active" : ""}
                onClick={() => {
                  setTool(entry.id);
                  if (entry.id === "image" && !pendingImage) imageRef.current?.click();
                  if (entry.id === "editText") setStatus(`${pageTextItems.length} text fragments detected on this page. Hover a word or phrase, then click it to replace it.`);
                  if (entry.id === "eraser") {
                    setStatus(engineHas("redactRegions")
                      ? "Eraser selected. Drag over content to mark it for removal, then export - it's permanently deleted, not just painted over. Click an existing annotation to remove just that."
                      : "Eraser selected. Click an existing annotation to remove it. Dragging over real PDF content needs the professional engine to permanently delete it - start it with `npm.cmd run engine`.");
                  }
                }}
                title={entry.label}
                aria-label={entry.label}
              >
                <Icon size={18} />
              </button>
            );
          })}
          <span className="tool-divider" />
          <button
            className="quick-action"
            onClick={() => {
              setTool("editText");
              setShowTextGuides(false);
              setStatus(`${pageTextItems.length} text fragments detected on this page. Hover a word or phrase, then click it to replace it.`);
            }}
            disabled={!pdfDocProxy}
            title="Edit existing text"
            aria-label="Edit existing text"
          >
            <Search size={16} />Edit Text
          </button>
          <button
            className="quick-action"
            onClick={() => setShowTextGuides((value) => !value)}
            disabled={!pdfDocProxy || tool !== "editText"}
            title="Show or hide detected text guides"
            aria-label="Show or hide detected text guides"
          >
            <CaseSensitive size={16} />{showTextGuides ? "Hide Guides" : "Show Guides"}
          </button>
          <button className="quick-action" onClick={convertPageTextToEditable} disabled={!pdfDocProxy || !pageTextItems.length} title="Make detected text editable" aria-label="Make detected text editable">
            <CaseSensitive size={16} />Make Editable
          </button>
          <button className="quick-action" onClick={runOcrCurrentPage} disabled={!pdfDocProxy || busy || pageLooksBlank} title="Run OCR on this page" aria-label="Run OCR on this page">
            <Search size={16} />OCR Page
          </button>
          <span className="tool-divider" />
          <button onClick={undo} disabled={!history.length} title="Undo (Ctrl+Z)" aria-label="Undo"><RotateCcw size={18} /></button>
          <button onClick={redo} disabled={!future.length} title="Redo (Ctrl+Y)" aria-label="Redo"><Redo2 size={18} /></button>
          <button onClick={duplicateSelected} disabled={!selectedId} title="Duplicate selection" aria-label="Duplicate selection"><Copy size={18} /></button>
          <button onClick={deleteSelected} disabled={!selectedId} title="Delete selection" aria-label="Delete selection"><Trash2 size={18} /></button>
          <button onClick={rotatePage} disabled={!pdfBytes} title="Rotate page on export" aria-label="Rotate page"><RotateCw size={18} /></button>
        </nav>

        <div className="page-stage" ref={pageStageRef}>
          {!pdfDocProxy ? (
            <>
              <div className="sticky-note"><span>Everything stays on your device.</span></div>
              <button className="dropzone" onClick={() => fileRef.current?.click()}>
                <ImagePlus size={38} />
                <strong>Open a PDF to edit locally</strong>
                <span>Rich text, fonts, arrows, notes, checks, images, redactions, page tools, merge, split, and export.</span>
              </button>
            </>
          ) : (
            <div className="paper-wrap" style={{ width: pageSize.width, height: pageSize.height }}>
              <canvas ref={canvasRef} className="pdf-canvas" />
              {matches.length > 0 && (
                <div className="search-highlight-layer">
                  {matches.map((m, i) => m.page === pageNumber && (
                    <div
                      key={`${m.page}-${i}`}
                      className={`search-highlight ${i === matchIndex ? "active" : ""}`}
                      style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` }}
                    />
                  ))}
                </div>
              )}
              {pageLooksBlank && !pageAnnotations.length && (
                <div className="blank-page-hint">
                  <strong>This page is blank</strong>
                  <span>You are on page {pageNumber}. Your PDF content is probably on page 1, or a blank page was inserted.</span>
                  <div>
                    <button onClick={() => setPageNumber(1)}>Go to page 1</button>
                    <button onClick={deleteCurrentPage} disabled={pageCount <= 1}>Delete blank page</button>
                  </div>
                </div>
              )}
              <div
                ref={overlayRef}
                className={`annotation-layer tool-${tool}`}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
              >
                {tool === "editText" && pageTextItems.map((item) => (
                  <div
                    key={item.id}
                    data-annotation="true"
                    className={`detected-text-box ${showTextGuides ? "visible" : "quiet"}`}
                    style={{
                      left: `${item.x * 100}%`,
                      top: `${item.y * 100}%`,
                      width: `${item.w * 100}%`,
                      height: `${item.h * 100}%`,
                    }}
                    title={`${item.str} | ${item.fontName || "unknown font"}`}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      editDetectedText(item);
                    }}
                  />
                ))}
                {[...pageAnnotations, draft].filter(Boolean).map((item) => {
                  if (item.points) {
                    const path = smoothPathD(item.points, pageSize.width, pageSize.height);
                    return (
                      <svg key={item.id} className="ink-layer" viewBox={`0 0 ${pageSize.width} ${pageSize.height}`}>
                        <path d={path} fill="none" stroke={item.color} strokeWidth={item.width || 2} strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    );
                  }
                  if (item.type === "rotate") return null;
                  return (
                    <div
                      key={item.id}
                      data-annotation="true"
                      className={`annotation ${item.type} ${selectedId === item.id ? "selected" : ""}`}
                      style={annotationStyle(item)}
                      onPointerDown={(event) => moveAnnotation(item.id, event)}
                    >
                      {(item.type === "text" || item.type === "textEdit" || item.type === "note") && (
                        <textarea
                          value={item.text}
                          placeholder={item.type === "text" ? "Type here" : item.type === "note" ? "Note" : undefined}
                          style={{
                            color: item.color,
                            fontSize: item.fontSize ? item.fontSize * (item.type === "textEdit" || item.detectedFontName === "OCR" ? zoom : 1) : undefined,
                            fontFamily: getCssFont(item.fontFamily),
                            fontWeight: item.bold ? 800 : 400,
                            fontStyle: item.italic ? "italic" : "normal",
                            textDecoration: item.underline ? "underline" : "none",
                            textAlign: item.align || "left",
                          }}
                          onPointerDown={(event) => {
                            if (tool === "select" && selectedId === item.id) event.stopPropagation();
                          }}
                          onFocus={() => setSelectedId(item.id)}
                          onChange={(event) => updateAnnotation(item.id, { text: event.target.value })}
                        />
                      )}
                      {item.type === "image" && <img src={item.dataUrl} alt="" />}
                      {(item.type === "line" || item.type === "arrow") && (() => {
                        const boxW = Math.max(1, item.w * pageSize.width);
                        const boxH = Math.max(1, item.h * pageSize.height);
                        const sx = item.x1 != null ? ((item.x1 - item.x) / (item.w || 0.0001)) * boxW : 0;
                        const sy = item.y1 != null ? ((item.y1 - item.y) / (item.h || 0.0001)) * boxH : boxH;
                        const ex = item.x2 != null ? ((item.x2 - item.x) / (item.w || 0.0001)) * boxW : boxW;
                        const ey = item.y2 != null ? ((item.y2 - item.y) / (item.h || 0.0001)) * boxH : 0;
                        const head = Math.max(9, (item.width || 2) * 4);
                        const angle = Math.atan2(ey - sy, ex - sx);
                        const h1x = ex - head * Math.cos(angle - Math.PI / 6);
                        const h1y = ey - head * Math.sin(angle - Math.PI / 6);
                        const h2x = ex - head * Math.cos(angle + Math.PI / 6);
                        const h2y = ey - head * Math.sin(angle + Math.PI / 6);
                        return (
                          <svg className="shape-svg" viewBox={`0 0 ${boxW} ${boxH}`} preserveAspectRatio="none" style={{ overflow: "visible" }}>
                            <line x1={sx} y1={sy} x2={ex} y2={ey} stroke="currentColor" strokeWidth={item.width || 2} strokeLinecap="round" />
                            {item.type === "arrow" && (
                              <polyline
                                points={`${h1x},${h1y} ${ex},${ey} ${h2x},${h2y}`}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth={item.width || 2}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            )}
                          </svg>
                        );
                      })()}
                      {item.type === "check" && (
                        <svg className="shape-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
                          <polyline points="12,48 38,76 88,14" fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                      {item.type === "stamp" && <span>{item.text}</span>}
                      {item.type === "watermark" && <span>{item.text}</span>}
                      {selectedId === item.id && !item.points && (
                        <>
                          {["nw", "ne", "sw", "se"].map((corner) => (
                            <i
                              key={corner}
                              className={`resize-handle ${corner}`}
                              onPointerDown={(event) => resizeAnnotation(item.id, corner, event)}
                            />
                          ))}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>

      <aside className="inspector">
        <div className="panel">
          <div className="panel-title">Document</div>
          <div className="pager">
            <button onClick={() => setPageNumber((page) => Math.max(1, page - 1))} disabled={pageNumber <= 1}><ChevronLeft size={17} /></button>
            <strong>{pageCount ? `${pageNumber} / ${pageCount}` : "No PDF"}</strong>
            <button onClick={() => setPageNumber((page) => Math.min(pageCount, page + 1))} disabled={pageNumber >= pageCount}><ChevronRight size={17} /></button>
          </div>
          <div className="zoom-row">
            <button onClick={() => setZoom((value) => clamp(value - 0.15, 0.25, 4))}><ZoomOut size={17} /></button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((value) => clamp(value + 0.15, 0.25, 4))}><ZoomIn size={17} /></button>
          </div>
          <button className="secondary-action compact" onClick={fitPageToWidth} disabled={!pdfDocProxy}>Fit page width</button>
          <p className="status">{busy ? "Working..." : status}</p>
        </div>

        <div className="panel">
          <div className="panel-title"><Layers size={16} />Pages</div>
          <div className="button-grid">
            <button onClick={() => moveCurrentPage(-1)} disabled={!pdfBytes || pageNumber <= 1 || busy}><ArrowUp size={16} />Move up</button>
            <button onClick={() => moveCurrentPage(1)} disabled={!pdfBytes || pageNumber >= pageCount || busy}><ArrowDown size={16} />Move down</button>
            <button onClick={insertBlankPage} disabled={!pdfBytes || busy}><FilePlus2 size={16} />Insert blank</button>
            <button onClick={duplicateCurrentPage} disabled={!pdfBytes || busy}><Copy size={16} />Duplicate page</button>
            <button onClick={deleteCurrentPage} disabled={!pdfBytes || pageCount <= 1 || busy}><Trash2 size={16} />Delete page</button>
            <button onClick={() => mergeRef.current?.click()} disabled={!pdfBytes || busy}><FileInput size={16} />Merge PDF</button>
          </div>
          <label className="field">
            Page range
            <input value={rangeText} onChange={(event) => setRangeText(event.target.value)} placeholder="1-3, 5" />
          </label>
          <div className="button-grid two">
            <button onClick={exportPageRange} disabled={!pdfBytes || busy}><FileOutput size={16} />Extract</button>
            <button onClick={splitPdf} disabled={!pdfBytes || busy}><Scissors size={16} />Split ZIP</button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title"><Layers size={16} />All Tools</div>
          <div className="tool-center">
            {TOOL_CENTER.map((group) => (
              <section key={group.title} className="tool-group">
                <strong>{group.title}</strong>
                {group.tools.map(([id, label]) => {
                  const badge = toolBadge(id);
                  const blocked = ENGINE_REQUIRED_TOOLS.has(id) && !engineHas(TOOL_ENGINE_FEATURE[id]);
                  return (
                    <button
                      key={id}
                      onClick={() => handleToolCenterAction(id)}
                      disabled={busy || blocked}
                      className={`badge-${badge.tone}`}
                      title={badge.title}
                    >
                      <span>{label.slice(0, 1)}</span>
                      <em>{label}</em>
                      <small>{badge.label}</small>
                    </button>
                  );
                })}
              </section>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title"><Palette size={16} />Style</div>
          <div className="font-intel">
            <strong>{selected?.type === "textEdit" ? "Detected text edit" : tool === "editText" ? "Auto font detection" : "Text styling"}</strong>
            <span>
              {selected?.type === "textEdit"
                ? `Original: ${selected.originalText || ""}`
                : tool === "editText"
                  ? `${pageTextItems.length} text fragments found on this page`
                  : "Use Text or Edit existing text for font controls"}
            </span>
            {selected?.type === "textEdit" && (
              <small>
                PDF font: {selected.detectedFontName || "unknown"} {selected.detectedFamily ? `(${selected.detectedFamily})` : ""}
              </small>
            )}
            {selected?.type === "textEdit" && (
              <div className="blend-controls">
                <label>
                  Cover
                  <input
                    type="color"
                    value={selected.coverColor || "#ffffff"}
                    onChange={(event) => updateAnnotation(selected.id, { coverColor: event.target.value })}
                  />
                </label>
                <label>
                  Pad
                  <input
                    type="range"
                    min="0"
                    max="6"
                    step="0.5"
                    value={selected.coverPad ?? 1.5}
                    onChange={(event) => updateAnnotation(selected.id, { coverPad: Number(event.target.value) })}
                  />
                </label>
                <button
                  className="secondary-action compact"
                  onClick={() => updateAnnotation(selected.id, { coverColor: sampleBackgroundColor(selected) })}
                >
                  Sample background
                </button>
              </div>
            )}
            {tool === "editText" && (
              <>
                <button className="secondary-action compact" onClick={() => setShowTextGuides((value) => !value)} disabled={!pageTextItems.length}>
                  {showTextGuides ? "Hide edit guides" : "Show edit guides"}
                </button>
                <button className="secondary-action compact" onClick={convertPageTextToEditable} disabled={!pageTextItems.length}>
                  Make page text editable
                </button>
              </>
            )}
            {pdfDocProxy && (
              <>
                <select
                  className="ocr-language-select"
                  value={ocrLanguage}
                  onChange={(event) => setOcrLanguage(event.target.value)}
                  disabled={busy}
                  title="OCR language"
                  aria-label="OCR language"
                >
                  {OCR_LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>{lang.label}</option>
                  ))}
                </select>
                <button className="secondary-action compact" onClick={runOcrCurrentPage} disabled={busy}>
                  OCR page to editable text
                </button>
                <small className={ocrEngineForLanguage().pro ? "ocr-engine-note is-pro" : "ocr-engine-note"}>
                  {ocrEngineForLanguage().label}
                </small>
              </>
            )}
            {ocrProgress && <small>{ocrProgress}</small>}
          </div>
          <div className="swatches">
            {SWATCHES.map((color) => (
              <button
                key={color}
                className={inkColor === color ? "active" : ""}
                style={{ background: color }}
                aria-label={`Use ${color}`}
                onClick={() => {
                  setInkColor(color);
                  if (selected) updateAnnotation(selected.id, { color });
                }}
              />
            ))}
          </div>
          <label className="field color-field">
            Custom color
            <input
              type="color"
              className="color-input"
              value={inkColor}
              onChange={(event) => {
                setInkColor(event.target.value);
                if (selected) updateAnnotation(selected.id, { color: event.target.value });
              }}
              aria-label="Pick a custom color"
            />
          </label>
          <label className="field">
            Font
            <select
              value={selected?.fontFamily || fontFamily}
              onChange={(event) => {
                setFontFamily(event.target.value);
                if (selected && ["text", "textEdit", "note", "watermark"].includes(selected.type)) updateAnnotation(selected.id, { fontFamily: event.target.value });
              }}
            >
              {FONT_OPTIONS.map((font) => (
                <option key={font.id} value={font.id}>{font.label}</option>
              ))}
            </select>
          </label>
          <div className="suggestion-row">
            {["helvetica", "times", "courier", "aptos"].map((font) => (
              <button
                key={font}
                onClick={() => {
                  setFontFamily(font);
                  if (selected && ["text", "textEdit", "note", "watermark"].includes(selected.type)) updateAnnotation(selected.id, { fontFamily: font });
                }}
              >
                {FONT_OPTIONS.find((item) => item.id === font)?.label}
              </button>
            ))}
          </div>
          <div className="segmented" aria-label="Text style controls">
            <button
              className={(selected?.bold ?? textBold) ? "active" : ""}
              onClick={() => {
                const value = !(selected?.bold ?? textBold);
                setTextBold(value);
                if (selected && ["text", "textEdit", "note", "watermark"].includes(selected.type)) updateAnnotation(selected.id, { bold: value });
              }}
              title="Bold"
            >
              <Bold size={16} />
            </button>
            <button
              className={(selected?.italic ?? textItalic) ? "active" : ""}
              onClick={() => {
                const value = !(selected?.italic ?? textItalic);
                setTextItalic(value);
                if (selected && ["text", "textEdit", "note", "watermark"].includes(selected.type)) updateAnnotation(selected.id, { italic: value });
              }}
              title="Italic"
            >
              <Italic size={16} />
            </button>
            <button
              className={(selected?.underline ?? textUnderline) ? "active" : ""}
              onClick={() => {
                const value = !(selected?.underline ?? textUnderline);
                setTextUnderline(value);
                if (selected && ["text", "textEdit", "note", "watermark"].includes(selected.type)) updateAnnotation(selected.id, { underline: value });
              }}
              title="Underline"
            >
              <Underline size={16} />
            </button>
          </div>
          <div className="segmented" aria-label="Text alignment controls">
            {[
              { id: "left", icon: AlignLeft, label: "Align left" },
              { id: "center", icon: AlignCenter, label: "Align center" },
              { id: "right", icon: AlignRight, label: "Align right" },
            ].map((entry) => {
              const Icon = entry.icon;
              return (
                <button
                  key={entry.id}
                  className={(selected?.align || textAlign) === entry.id ? "active" : ""}
                  onClick={() => {
                    setTextAlign(entry.id);
                    if (selected && ["text", "textEdit", "note", "watermark"].includes(selected.type)) updateAnnotation(selected.id, { align: entry.id });
                  }}
                  title={entry.label}
                >
                  <Icon size={16} />
                </button>
              );
            })}
          </div>
          <label className="field">
            Font size
            <input
              type="range"
              min="10"
              max="96"
              value={selected?.fontSize || fontSize}
              onChange={(event) => {
                const value = Number(event.target.value);
                setFontSize(value);
                if (selected && ["text", "textEdit", "note", "watermark"].includes(selected.type)) updateAnnotation(selected.id, { fontSize: value });
              }}
            />
          </label>
          <label className="field">
            Stroke width
            <input
              type="range"
              min="1"
              max="12"
              value={selected?.width || strokeWidth}
              onChange={(event) => {
                const value = Number(event.target.value);
                setStrokeWidth(value);
                if (selected) updateAnnotation(selected.id, { width: value });
              }}
            />
          </label>
          <label className="field">
            Opacity
            <input
              type="range"
              min="0.05"
              max="1"
              step="0.05"
              value={selected?.opacity ?? opacity}
              onChange={(event) => {
                const value = Number(event.target.value);
                setOpacity(value);
                if (selected) updateAnnotation(selected.id, { opacity: value });
              }}
            />
          </label>
          <label className="field">
            Stamp
            <input
              value={selected?.type === "stamp" ? selected.text : stampText}
              onChange={(event) => {
                setStampText(event.target.value);
                if (selected?.type === "stamp") updateAnnotation(selected.id, { text: event.target.value });
              }}
            />
          </label>
          <label className="field">
            Watermark
            <input value={watermarkText} onChange={(event) => setWatermarkText(event.target.value)} />
          </label>
          <button className="secondary-action" onClick={applyWatermark} disabled={!pdfBytes || busy}>Apply watermark to all pages</button>
        </div>

        <div className="panel">
          <div className="panel-title"><FileOutput size={16} />Convert / Save As</div>
          <button className="secondary-action" onClick={() => convertRef.current?.click()} disabled={busy}>
            Open Word, Excel, PowerPoint, text, image as PDF
          </button>
          <div className="button-grid two">
            <button onClick={exportPdfAsText} disabled={!pdfDocProxy || busy}><FileOutput size={16} />TXT</button>
            <button onClick={exportPdfAsDocx} disabled={!pdfDocProxy || busy}><FileOutput size={16} />DOCX</button>
            <button onClick={exportPdfAsXlsx} disabled={!pdfDocProxy || busy}><FileOutput size={16} />XLSX</button>
            <button onClick={exportPdfAsCsv} disabled={!pdfDocProxy || busy}><FileOutput size={16} />CSV</button>
            <button onClick={exportCurrentPagePng} disabled={!pdfDocProxy || busy}><ImagePlus size={16} />PNG</button>
            <button onClick={exportAllPagesPngZip} disabled={!pdfDocProxy || busy}><Scissors size={16} />PNG ZIP</button>
          </div>
          <p className="fine-print">Smart Engine supports DOCX/XLSX/PPTX text conversion, report-to-XLSX columns, archive rebuilds, owner-unlock rebuilds, and flattened protection.</p>
        </div>

        <div className="panel">
          <div className="panel-title"><ShieldCheck size={16} />Professional Engine</div>
          <div className={`engine-banner ${nativeEngine.checked ? (nativeEngine.ok ? "on" : "off") : "checking"}`}>
            {nativeEngine.checked
              ? (nativeEngine.ok ? "Professional engine connected" : "Engine off - using browser fallbacks")
              : "Checking engine..."}
          </div>
          {nativeEngine.checked && (
            <>
              <div className="engine-caps">
                <span className={nativeEngine.pymupdf ? "cap-on" : "cap-off"}>PyMuPDF</span>
                <span className={nativeEngine.pikepdf ? "cap-on" : "cap-off"}>pikepdf</span>
                <span className={nativeEngine.pdf2docx ? "cap-on" : "cap-off"}>PDF&rarr;Word</span>
                <span className={engineHas("wordToPdf") ? "cap-on" : "cap-off"}>Office&rarr;PDF</span>
                <span className={engineHas("htmlToPdf") ? "cap-on" : "cap-off"}>HTML&rarr;PDF</span>
              </div>
              {(nativeEngine.officeEngine || nativeEngine.htmlEngine) && (
                <p className="fine-print">
                  {nativeEngine.officeEngine ? `Office via ${nativeEngine.officeEngine}` : "Office conversion off"}
                  {nativeEngine.htmlEngine ? ` · HTML via ${nativeEngine.htmlEngine}` : ""}
                </p>
              )}
            </>
          )}
          <button className="secondary-action compact" onClick={refreshNativeEngine}>
            Refresh engine status
          </button>

          <label className="field">
            Compression level
            <select value={compressLevel} onChange={(event) => setCompressLevel(event.target.value)}>
              <option value="light">Light (lossless cleanup)</option>
              <option value="medium">Medium (150 DPI images)</option>
              <option value="strong">Strong (110 DPI images)</option>
              <option value="extreme">Extreme (72 DPI images)</option>
            </select>
          </label>
          <button className="secondary-action compact" onClick={() => compressPdf()} disabled={!pdfBytes || busy}>
            Compress PDF now
          </button>

          <label className="field">
            Unlock password (optional)
            <input value={nativePassword} onChange={(event) => setNativePassword(event.target.value)} type="password" placeholder="For encrypted PDFs" />
          </label>
          <label className="field">
            Protect password
            <input value={protectPassword} onChange={(event) => setProtectPassword(event.target.value)} type="password" placeholder="Real AES-256 encryption" />
          </label>
          <p className="fine-print">Run `npm.cmd run engine` beside Vite for compression, real Office conversion, PDF/A, unlock, AES-256 protect, and watermark removal.</p>
        </div>

        <div className="panel">
          <div className="panel-title"><KeyRound size={16} />Recover PDF Password</div>
          <p className="fine-print">
            For a PDF that needs a password just to open (not owner restrictions - Unlock PDF handles those instantly with no password needed). Pick the locked file with Open first - it won't render in the editor, but it's ready for recovery here. Runs on the server engine only; searches are capped in time and size so this stays safe on a shared server.
          </p>
          <label className="field">
            Mode
            <select value={crackMode} onChange={(event) => setCrackMode(event.target.value)} disabled={crackJob?.status === "running" || crackJob?.status === "starting"}>
              <option value="pin">Numeric PIN (birthdates, short PINs)</option>
              <option value="dictionary">Dictionary (common passwords + your own list)</option>
              <option value="charset">Custom character set brute force</option>
            </select>
          </label>
          {crackMode === "pin" && (
            <div className="field-row">
              <label className="field">
                Min digits
                <input type="number" min={1} max={12} value={crackMinLen} onChange={(event) => setCrackMinLen(Math.max(1, Math.min(12, Number(event.target.value) || 1)))} />
              </label>
              <label className="field">
                Max digits
                <input type="number" min={1} max={12} value={crackMaxLen} onChange={(event) => setCrackMaxLen(Math.max(1, Math.min(12, Number(event.target.value) || 1)))} />
              </label>
            </div>
          )}
          {crackMode === "dictionary" && (
            <label className="field">
              Custom word list (optional, .txt, one password per line)
              <input type="file" accept=".txt" onChange={(event) => setCrackWordlistFile(event.target.files?.[0] || null)} />
            </label>
          )}
          {crackMode === "charset" && (
            <>
              <div className="field-row">
                <label className="checkbox-field">
                  <input type="checkbox" checked={crackCharsetLower} onChange={(event) => setCrackCharsetLower(event.target.checked)} /> a-z
                </label>
                <label className="checkbox-field">
                  <input type="checkbox" checked={crackCharsetUpper} onChange={(event) => setCrackCharsetUpper(event.target.checked)} /> A-Z
                </label>
                <label className="checkbox-field">
                  <input type="checkbox" checked={crackCharsetDigits} onChange={(event) => setCrackCharsetDigits(event.target.checked)} /> 0-9
                </label>
                <label className="checkbox-field">
                  <input type="checkbox" checked={crackCharsetSymbols} onChange={(event) => setCrackCharsetSymbols(event.target.checked)} /> !@#$...
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  Min length
                  <input type="number" min={1} max={10} value={crackMinLen} onChange={(event) => setCrackMinLen(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} />
                </label>
                <label className="field">
                  Max length
                  <input type="number" min={1} max={10} value={crackMaxLen} onChange={(event) => setCrackMaxLen(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} />
                </label>
              </div>
            </>
          )}
          {(crackMode === "pin" || crackMode === "charset") && (
            <p className="fine-print">
              Up to {crackEstimatedCombos()?.toLocaleString() || 0} combinations
              {crackEstimatedCombos() > 20000000 ? " - too many, the engine will reject this. Narrow the range." : "."}
            </p>
          )}
          {!crackJob && (
            <button className="secondary-action" onClick={startPasswordCrack} disabled={(!pdfBytes && !lockedPdf) || !engineHas("crackPassword")}>
              <KeyRound size={16} />Start recovery
            </button>
          )}
          {crackJob && (crackJob.status === "starting" || crackJob.status === "running") && (
            <>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${crackJob.total ? Math.min(100, ((crackJob.attempts || 0) / crackJob.total) * 100) : 0}%` }}
                />
              </div>
              <p className="fine-print">
                {(crackJob.attempts || 0).toLocaleString()}{crackJob.total ? ` / ${crackJob.total.toLocaleString()}` : ""} tried
                {" · "}{Math.round(crackJob.elapsedSeconds || 0)}s elapsed
              </p>
              <button className="secondary-action compact" onClick={cancelPasswordCrack}>Cancel</button>
            </>
          )}
          {crackJob && (crackJob.status === "done" || crackJob.status === "error" || crackJob.status === "cancelled") && (
            <button className="secondary-action compact" onClick={() => setCrackJob(null)}>Start another search</button>
          )}
          {!engineHas("crackPassword") && nativeEngine.checked && (
            <p className="fine-print">Start the engine (`npm.cmd run engine`) and Refresh to enable this.</p>
          )}
        </div>

        <div className="panel">
          <div className="panel-title"><Wand2 size={16} />Remove PDF Watermark</div>
          <p className="fine-print">
            Removes watermarks at the PDF-object level (layers, stamps, repeated images, and marked text) so the real content underneath stays sharp - not a flattened picture.
          </p>
          <label className="field">
            Mode
            <select value={removeWmMode} onChange={(event) => setRemoveWmMode(event.target.value)}>
              <option value="auto">Auto detect (layers + images + marks)</option>
              <option value="text">Exact text watermark</option>
              <option value="images">Repeated image / logo stamp</option>
              <option value="layers">Watermark layers (OCG)</option>
              <option value="annots">Stamp / watermark annotations</option>
            </select>
          </label>
          {removeWmMode === "text" && (
            <label className="field">
              Watermark text to remove
              <input value={removeWmText} onChange={(event) => setRemoveWmText(event.target.value)} placeholder="e.g. CONFIDENTIAL" />
            </label>
          )}
          <button className="secondary-action" onClick={removeWatermark} disabled={!pdfBytes || busy || !engineHas("removeWatermark")}>
            <Wand2 size={16} />Remove watermark
          </button>
          {!engineHas("removeWatermark") && nativeEngine.checked && (
            <p className="fine-print">Start the engine (`npm.cmd run engine`) and Refresh to enable this.</p>
          )}
        </div>

        <div className="panel">
          <div className="panel-title"><MessageSquare size={16} />AI / API Guide</div>
          <label className="field">
            API base URL
            <input value={apiBase} onChange={(event) => setApiBase(event.target.value)} placeholder="https://api.openai.com/v1" />
          </label>
          <label className="field">
            API key
            <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Stored for this session only" type="password" />
          </label>
          <label className="field">
            Model
            <input value={apiModel} onChange={(event) => setApiModel(event.target.value)} placeholder="gpt-4o-mini" />
          </label>
          <label className="field">
            What do you want to do?
            <textarea className="ai-prompt" value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} />
          </label>
          <div className="button-grid two">
            <button onClick={rememberAiSettings}>Save session</button>
            <button onClick={() => askAiGuide()} disabled={busy}>Ask AI</button>
          </div>
          <button className="secondary-action compact" onClick={testAiConnection} disabled={busy}>
            Test connection &amp; list my models
          </button>
          {aiAnswer && <pre className="ai-answer">{aiAnswer}</pre>}
          <p className="fine-print">Works with any OpenAI-compatible API (OpenAI, xAI/Grok, OpenRouter, local), plus Anthropic and Gemini. If "Ask AI" says "Not found", click Test connection to see your exact model IDs. Your key stays in browser session storage only.</p>
        </div>

        <div className="panel">
          <div className="panel-title"><ShieldCheck size={16} />Local promise</div>
          <p className="fine-print">Files are opened in your browser session. Export creates a new PDF and keeps the original untouched.</p>
          <button className="download" onClick={exportPdf} disabled={!pdfBytes || busy}><ArrowDownToLine size={17} />Download edited PDF</button>
        </div>
      </aside>
    </main>
      )}
    </PaperShell>
  );
}

export default App;
