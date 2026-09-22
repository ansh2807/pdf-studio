const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { RateLimiter } = require("./engine/rateLimiter.cjs");
const { safeName } = require("./engine/safeName.cjs");

// --------------------------------------------------------------------------- //
// Config
//   - Dev (local, beside Vite): binds 127.0.0.1:5174, no static serving.
//   - Prod (Docker / VPS): PORT is set, serves the built dist/, binds 0.0.0.0.
// --------------------------------------------------------------------------- //
const IS_WINDOWS = process.platform === "win32";
const PORT = Number(process.env.PORT || process.env.PDF_ENGINE_PORT || 5174);
const ROOT = __dirname;
const ENGINE_PY = path.join(ROOT, "engine.py");
const WATERMARK_PY = path.join(ROOT, "engine", "watermark", "photo_watermark.py");
const BG_REMOVE_PY = path.join(ROOT, "engine", "background", "remove_bg.py");
const OFFICE_PS1 = path.join(ROOT, "office-convert.ps1");
const DIST_DIR = path.join(ROOT, "dist");
const HAS_DIST = (() => { try { return fs.existsSync(path.join(DIST_DIR, "index.html")); } catch { return false; } })();
const SERVE_STATIC = HAS_DIST || process.env.SERVE_STATIC === "1";
const BIND = process.env.BIND_HOST || (process.env.PORT || SERVE_STATIC ? "0.0.0.0" : "127.0.0.1");
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024;

// The AI proxy relays to an outside provider using a key the CALLER supplies
// (no server-side key to leak), but with no limiter a public deploy is an
// open, anonymous, unmetered relay for anyone on the internet. Capacity 10,
// refills 10/min - generous for the one legitimate caller (occasional
// AI-enhance clicks in Photo Studio), throttles a script fast.
const AI_RATE_CAPACITY = Number(process.env.AI_RATE_CAPACITY || 10);
const AI_RATE_PER_MIN = Number(process.env.AI_RATE_PER_MIN || 10);
const aiRateLimiter = new RateLimiter({ capacity: AI_RATE_CAPACITY, refillPerSec: AI_RATE_PER_MIN / 60 });
setInterval(() => aiRateLimiter.sweep(3600), 10 * 60 * 1000).unref?.();

// The deep-learning routes (LaMa watermark inpainting, U2Net background
// segmentation) and Office/HTML conversion (LibreOffice/COM automation) are
// the most CPU-expensive operations in the whole server - 7-25s of inference
// each, or a full document-conversion process spin-up. With the wildcard
// CORS this server already sends, any website could embed hidden requests
// that hammer these routes and exhaust a deployed instance's CPU. Capacity
// 20, refill 10/min - generous enough for a real multi-file editing session,
// still bounded against a scripted flood.
const COMPUTE_RATE_CAPACITY = Number(process.env.COMPUTE_RATE_CAPACITY || 20);
const COMPUTE_RATE_PER_MIN = Number(process.env.COMPUTE_RATE_PER_MIN || 10);
const computeRateLimiter = new RateLimiter({ capacity: COMPUTE_RATE_CAPACITY, refillPerSec: COMPUTE_RATE_PER_MIN / 60 });
setInterval(() => computeRateLimiter.sweep(3600), 10 * 60 * 1000).unref?.();
const COMPUTE_HEAVY_ROUTES = new Set([
  "/api/native/photo-watermark-remove",
  "/api/native/background-remove",
  "/api/native/office-to-pdf",
  "/api/native/html-to-pdf",
  // OCR is detection + recognition inference over a full page render: seconds
  // of pinned CPU per request, and ocr-pdf multiplies that by the page count.
  "/api/native/ocr",
  "/api/native/ocr-pdf",
  // Page-level + word-level diff across two whole documents.
  "/api/native/compare",
  // Starts a background brute-force/dictionary job that can pin a CPU core
  // for minutes; the job itself is further capped by MAX_CONCURRENT_CRACK_JOBS.
  "/api/native/pdf-crack/start",
]);

// A crack job can run for minutes of real CPU time, so unlike every other
// route (bounded to a few seconds), concurrency itself - not just request
// rate - needs a hard cap on a shared host.
const MAX_CONCURRENT_CRACK_JOBS = Number(process.env.MAX_CRACK_JOBS || 2);
const CRACK_JOB_MAX_SECONDS = Number(process.env.CRACK_JOB_MAX_SECONDS || 300);
const CRACK_JOB_TTL_MS = 15 * 60 * 1000;
const crackJobs = new Map();

const MIME = {
  pdf: "application/pdf",
  json: "application/json; charset=utf-8",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png",
};

const STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

function exists(file) {
  try {
    return Boolean(file && fs.existsSync(file));
  } catch {
    return false;
  }
}

function findCommand(names, extraPaths = []) {
  for (const candidate of extraPaths) {
    if (exists(candidate)) return candidate;
  }
  for (const name of names) {
    const check = spawnSync(IS_WINDOWS ? "where.exe" : "which", [name], { encoding: "utf8" });
    if (check.status === 0) {
      const found = check.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (found) return found;
    }
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Capability detection (cached; the app can force a refresh)
// --------------------------------------------------------------------------- //
let cachedCaps = null;

function findPython() {
  const direct = findCommand([process.env.PYTHON_BIN, "python3", "python"].filter(Boolean));
  if (direct) return { cmd: direct, args: [] };
  const py = findCommand(["py"]);
  if (py) return { cmd: py, args: ["-3"] };
  return null;
}

function findBrowser() {
  return findCommand(
    [process.env.CHROME_BIN, "chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "msedge", "chrome"].filter(Boolean),
    [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
    ],
  );
}

function findLibreOffice() {
  return findCommand(["soffice", "libreoffice"], [
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/opt/libreoffice/program/soffice",
  ]);
}

function officeApps() {
  const bases = [
    "C:\\Program Files\\Microsoft Office\\root\\Office16",
    "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16",
    "C:\\Program Files\\Microsoft Office\\Office16",
    "C:\\Program Files (x86)\\Microsoft Office\\Office16",
    "C:\\Program Files\\Microsoft Office\\Office15",
  ];
  const result = { word: false, excel: false, powerpoint: false };
  if (!IS_WINDOWS) return result;
  for (const base of bases) {
    if (exists(path.join(base, "WINWORD.EXE"))) result.word = true;
    if (exists(path.join(base, "EXCEL.EXE"))) result.excel = true;
    if (exists(path.join(base, "POWERPNT.EXE"))) result.powerpoint = true;
  }
  return result;
}

function detectCapabilities(force = false) {
  if (cachedCaps && !force) return cachedCaps;
  const python = findPython();
  let py = { ok: false };
  if (python) {
    const probe = spawnSync(python.cmd, [...python.args, ENGINE_PY, "capabilities"], { encoding: "utf8" });
    if (probe.status === 0) {
      try {
        py = JSON.parse(probe.stdout.trim().split(/\r?\n/).pop());
      } catch {
        py = { ok: false, error: "capability probe parse failed" };
      }
    }
  }
  const office = officeApps();
  const libreOffice = findLibreOffice();
  const browser = findBrowser();
  cachedCaps = {
    python: python ? { cmd: python.cmd, args: python.args } : null,
    py,
    office,
    libreOffice,
    browser,
    officeComReady: IS_WINDOWS && (office.word || office.excel || office.powerpoint),
  };
  return cachedCaps;
}

function capabilitySummary(force = false) {
  const caps = detectCapabilities(force);
  const py = caps.py || {};
  const officeToPdf = Boolean(caps.libreOffice || caps.officeComReady);
  const htmlToPdf = Boolean(caps.browser || caps.libreOffice);
  // Which backend actually handles each conversion, for display.
  const officeEngine = caps.officeComReady ? "Microsoft Office" : caps.libreOffice ? "LibreOffice" : null;
  const htmlEngine = caps.browser ? "Chromium/Edge" : caps.libreOffice ? "LibreOffice" : null;
  // OCR degrades in three steps, so the front-end needs to know not just
  // "is there an engine" but WHICH languages it can actually do - anything
  // outside that list has to fall back to the browser's tesseract.js.
  const ocr = py.ocr || {};
  return {
    ok: Boolean(py.ok),
    python: Boolean(caps.python),
    pythonVersion: py.python || null,
    pymupdf: Boolean(py.pymupdf),
    pikepdf: Boolean(py.pikepdf),
    pdf2docx: Boolean(py.pdf2docx),
    openpyxl: Boolean(py.openpyxl),
    pptx: Boolean(py.pptx),
    office: caps.office,
    officeEngine,
    htmlEngine,
    libreOffice: Boolean(caps.libreOffice),
    edge: htmlToPdf,
    ocrEngine: ocr.engineName || null,
    ocrLanguages: ocr.languages || [],
    ocrTesseract: Boolean(ocr.tesseract),
    features: {
      compress: Boolean(py.pymupdf),
      repair: Boolean(py.pymupdf || py.pikepdf),
      unlock: Boolean(py.pikepdf),
      crackPassword: Boolean(py.pikepdf),
      protect: Boolean(py.pikepdf),
      pdfa: Boolean(py.pymupdf),
      pdfToImages: Boolean(py.pymupdf),
      pdfToExcel: Boolean(py.pymupdf && py.openpyxl),
      pdfToWord: Boolean(py.pdf2docx || py.docx),
      pdfToPpt: Boolean(py.pymupdf && py.pptx),
      removeWatermark: Boolean(py.pymupdf),
      redactRegions: Boolean(py.pymupdf),
      compare: Boolean(py.pymupdf),
      summarize: Boolean(py.pymupdf),
      ocr: Boolean(py.pymupdf && ocr.available),
      ocrPdf: Boolean(py.pymupdf && ocr.available),
      photoWatermark: Boolean(py.opencv && py.numpy),
      photoWatermarkDeep: Boolean(py.opencv && py.numpy && py.lama),
      bgRemoval: Boolean(py.opencv && py.numpy && py.bgRemoval),
      wordToPdf: officeToPdf,
      excelToPdf: officeToPdf,
      pptToPdf: officeToPdf,
      htmlToPdf,
    },
    libreOfficePath: caps.libreOffice,
    qpdf: Boolean(py.pikepdf),
  };
}

// --------------------------------------------------------------------------- //
// HTTP helpers
// --------------------------------------------------------------------------- //
function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Expose-Headers": "Content-Disposition, X-Engine-Report",
    ...extra,
  };
}

// Trust X-Forwarded-For only in the shape Caddy sends it (this container is
// meant to sit behind Caddy per docker-compose.yml); falls back to the raw
// socket address for direct/dev access.
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function sendJson(res, status, payload) {
  res.writeHead(status, corsHeaders({ "Content-Type": MIME.json }));
  res.end(JSON.stringify(payload));
}

function sendFile(res, file, name, mime, report) {
  const headers = corsHeaders({
    "Content-Type": mime || MIME.pdf,
    "Content-Disposition": `attachment; filename="${name}"`,
  });
  if (report) headers["X-Engine-Report"] = Buffer.from(JSON.stringify(report)).toString("base64");
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        // Reject WITHOUT destroying the request here: req and res share the
        // same underlying socket in Node's http module, and req.destroy()
        // tears that socket down immediately - confirmed by direct testing,
        // the client got a raw "Connection was reset" instead of the clean
        // 413 JSON error this was supposed to send. The oversized-upload
        // protection itself still works (we stop buffering further chunks
        // below regardless); only the error-delivery ordering was wrong.
        // The caller's response is sent first, and the still-streaming
        // request is cleaned up via the res "finish" hook installed in the
        // server's request handler, once that response has actually gone out.
        if (!rejected) {
          rejected = true;
          const err = new Error(`Upload exceeds ${Math.round(MAX_UPLOAD / 1024 / 1024)} MB limit`);
          err.status = 413;
          reject(err);
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on("error", (err) => { if (!rejected) { rejected = true; reject(err); } });
  });
}

function parseMultipart(req, body) {
  const contentType = req.headers["content-type"] || "";
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1]
    || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) return { fields: {}, files: {} };
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = body.indexOf(marker);
  while (cursor !== -1) {
    const next = body.indexOf(marker, cursor + marker.length);
    if (next === -1) break;
    const part = body.slice(cursor + marker.length + 2, next - 2);
    if (part.length) parts.push(part);
    cursor = next;
  }
  const fields = {};
  const files = {};
  for (const part of parts) {
    const split = part.indexOf(Buffer.from("\r\n\r\n"));
    if (split === -1) continue;
    const header = part.slice(0, split).toString("utf8");
    const data = part.slice(split + 4);
    const name = header.match(/name="([^"]+)"/)?.[1];
    const filename = header.match(/filename="([^"]*)"/)?.[1];
    if (!name) continue;
    if (filename) files[name] = { filename, data };
    else fields[name] = data.toString("utf8");
  }
  return { fields, files };
}

async function withTemp(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-pdf-engine-"));
  try {
    return await work(dir);
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error.message) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runEngine(command, extraArgs) {
  const caps = detectCapabilities();
  if (!caps.python) throw new Error("Python was not found on this machine.");
  const args = [...caps.python.args, ENGINE_PY, command, ...extraArgs];
  // Without this, Python falls back to the host's default console encoding
  // (cp1252 on a non-UTF8 Windows box) for stdout/stdin, corrupting any non-
  // ASCII character - currency symbols (EUR/GBP/INR), accented names, CJK
  // text - the moment a command needs to print or read one. Confirmed by
  // reproducing it: euro/pound signs came back as replacement characters
  // without this, and read back correctly with it.
  const result = await runCapture(caps.python.cmd, args, { env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
  let report = null;
  try {
    report = JSON.parse(line);
  } catch {
    report = null;
  }
  if (result.code !== 0 || !report || report.ok === false) {
    const message = (report && report.error) || result.stderr || `engine ${command} failed`;
    const error = new Error(message);
    error.report = report;
    error.needsPassword = Boolean(report && report.needsPassword);
    throw error;
  }
  return report;
}

// Runs the standalone photo-watermark engine (engine/watermark/photo_watermark.py)
// - a plain script, not one of engine.py's `command` subcommands.
async function runPhotoWatermark(extraArgs) {
  const caps = detectCapabilities();
  if (!caps.python) throw new Error("Python was not found on this machine.");
  const args = [...caps.python.args, WATERMARK_PY, ...extraArgs];
  const result = await runCapture(caps.python.cmd, args);
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
  let report = null;
  try { report = JSON.parse(line); } catch { report = null; }
  if (result.code !== 0 || !report || report.ok === false) {
    throw new Error((report && report.error) || result.stderr || "photo watermark removal failed");
  }
  return report;
}

// POST /api/native/photo-watermark-remove
// multipart fields: file (image), x, y, w, h (pixel rect in the UPLOADED
// image's own pixel space - the browser already scales crop coords to match
// before sending, same convention buildCleanupCanvas already used).
async function handlePhotoWatermarkRemove(req, res) {
  const body = await readBody(req);
  const { fields, files } = parseMultipart(req, body);
  const upload = pickUpload(files);
  if (!upload) return sendJson(res, 400, { error: "No image uploaded" });
  const rect = ["x", "y", "w", "h"].map((k) => Number(fields[k]));
  if (rect.some((n) => !Number.isFinite(n)) || rect[2] <= 0 || rect[3] <= 0) {
    return sendJson(res, 400, { error: "Invalid or missing crop rect (x, y, w, h)" });
  }
  await withTemp(async (dir) => {
    const inputName = safeName(upload.filename, "input.png");
    const ext = (path.extname(inputName) || ".png").toLowerCase();
    const input = path.join(dir, `input${ext}`);
    const output = path.join(dir, `output${ext}`);
    fs.writeFileSync(input, upload.data);
    const args = ["--input", input, "--output", output,
      "--rect", ...rect.map(String)];
    try {
      const report = await runPhotoWatermark(args);
      if (!exists(output)) return sendJson(res, 500, { error: "watermark removal produced no file" });
      const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
        : ext === ".webp" ? "image/webp" : MIME.png;
      sendFile(res, output, `watermark-removed${ext}`, mime, report);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });
}

// Runs the standalone background-removal engine (engine/background/remove_bg.py).
async function runBgRemoval(extraArgs) {
  const caps = detectCapabilities();
  if (!caps.python) throw new Error("Python was not found on this machine.");
  const args = [...caps.python.args, BG_REMOVE_PY, ...extraArgs];
  const result = await runCapture(caps.python.cmd, args);
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
  let report = null;
  try { report = JSON.parse(line); } catch { report = null; }
  if (result.code !== 0 || !report || report.ok === false) {
    throw new Error((report && report.error) || result.stderr || "background removal failed");
  }
  return report;
}

// POST /api/native/background-remove
// multipart fields: file (image), optional bgColor (hex RRGGBB - composites
// onto that solid colour; omit for a transparent PNG), optional threshold
// (0..1 - hard-cuts the mask instead of a soft matte).
async function handleBgRemove(req, res) {
  const body = await readBody(req);
  const { fields, files } = parseMultipart(req, body);
  const upload = pickUpload(files);
  if (!upload) return sendJson(res, 400, { error: "No image uploaded" });
  await withTemp(async (dir) => {
    const inputName = safeName(upload.filename, "input.png");
    const inExt = (path.extname(inputName) || ".png").toLowerCase();
    // Output is always PNG: transparency needs it, and a solid-colour
    // composite is fine as PNG too (the caller can re-encode client-side).
    const input = path.join(dir, `input${inExt}`);
    const output = path.join(dir, "output.png");
    fs.writeFileSync(input, upload.data);
    const args = ["--input", input, "--output", output];
    if (fields.bgColor) args.push("--bg-color", String(fields.bgColor).replace(/^#/, ""));
    if (fields.threshold) args.push("--threshold", String(Number(fields.threshold)));
    try {
      const report = await runBgRemoval(args);
      if (!exists(output)) return sendJson(res, 500, { error: "background removal produced no file" });
      sendFile(res, output, "background-removed.png", MIME.png, report);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });
}

// --------------------------------------------------------------------------- //
// Office / HTML conversion
// --------------------------------------------------------------------------- //
function officeExt(filename) {
  return (path.extname(filename || "").toLowerCase().replace(".", "") || "");
}

async function runComToPdf(input, output) {
  const result = await runCapture("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", OFFICE_PS1,
    "-InputPath", input, "-OutputPath", output,
  ]);
  const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
  let report = null;
  try { report = JSON.parse(line); } catch { report = null; }
  if (result.code !== 0 || !report || report.ok === false || !exists(output)) {
    throw new Error((report && report.error) || result.stderr || "Office conversion failed");
  }
  return report;
}

async function runLibreOfficeToPdf(input, output, dir) {
  const caps = detectCapabilities();
  if (!caps.libreOffice) throw new Error("LibreOffice was not found.");
  // A unique user profile avoids "another instance is running" collisions.
  const profile = path.join(dir, "lo-profile");
  const result = await runCapture(caps.libreOffice, [
    "--headless", "--norestore", "--nolockcheck",
    `-env:UserInstallation=file://${profile.replace(/\\/g, "/")}`,
    "--convert-to", "pdf", "--outdir", dir, input,
  ]);
  const produced = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith(".pdf"));
  if (!produced) throw new Error(result.stderr || "LibreOffice did not produce a PDF");
  const producedPath = path.join(dir, produced);
  if (producedPath !== output) fs.renameSync(producedPath, output);
  return { ok: true, app: "LibreOffice" };
}

async function runOfficeToPdf(input, output, dir) {
  const caps = detectCapabilities();
  // Highest fidelity: real MS Office via COM (Windows only).
  if (caps.officeComReady) {
    try {
      return await runComToPdf(input, output);
    } catch (error) {
      if (!caps.libreOffice) throw error;
      // fall through to LibreOffice
    }
  }
  return runLibreOfficeToPdf(input, output, dir);
}

async function runBrowserHtmlToPdf(input, output) {
  const caps = detectCapabilities();
  if (!caps.browser) return false;
  const uri = "file://" + (IS_WINDOWS ? "/" + input.replace(/\\/g, "/") : input);
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "browser-pdf-"));
  try {
    const args = [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${udd}`, `--print-to-pdf=${output}`, "--print-to-pdf-no-header", uri,
    ];
    if (!IS_WINDOWS) args.unshift("--no-sandbox", "--disable-dev-shm-usage");
    await runCapture(caps.browser, args);
    for (let i = 0; i < 20 && !exists(output); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return exists(output);
  } catch {
    return false;
  } finally {
    fs.rm(udd, { recursive: true, force: true }, () => {});
  }
}

// HTML -> PDF. Prefer a real browser (best CSS fidelity, e.g. Edge on Windows);
// fall back to LibreOffice, which renders basic HTML reliably in headless Linux
// where a bundled Chromium build can be fragile.
async function runHtmlToPdf(input, output, dir) {
  if (await runBrowserHtmlToPdf(input, output)) return { ok: true, app: "Chromium/Edge" };
  const caps = detectCapabilities();
  if (caps.libreOffice) {
    await runLibreOfficeToPdf(input, output, dir);
    return { ok: true, app: "LibreOffice" };
  }
  throw new Error("HTML to PDF needs Chromium/Edge or LibreOffice, and neither was found.");
}

// --------------------------------------------------------------------------- //
// AI proxy - forwards chat/vision requests to the provider server-side so the
// browser never hits provider CORS. Supports OpenAI-compatible, Anthropic, and
// Gemini. An SSRF guard blocks internal hosts since the hosted app is public.
// --------------------------------------------------------------------------- //
const dns = require("dns").promises;

function isPrivateIp(ip) {
  const v = ip.replace(/^::ffff:/i, "");
  if (/^127\.|^10\.|^0\.|^169\.254\.|^192\.168\./.test(v)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(v)) return true;
  if (v === "::1" || /^f[cd]/i.test(v) || /^fe80:/i.test(v)) return true;
  return false;
}

async function assertPublicHttps(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error("Invalid API base URL"); }
  if (u.protocol !== "https:") throw new Error("Only https:// AI endpoints are allowed");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("That host is not allowed");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIp(host)) throw new Error("That host is not allowed");
  try {
    const records = await dns.lookup(host, { all: true });
    if (records.some((r) => isPrivateIp(r.address))) throw new Error("That host resolves to a private address");
  } catch (error) {
    if (String(error.message).includes("private")) throw error;
    // DNS failure will surface naturally on the fetch below
  }
  return u;
}

function extractText(provider, data) {
  if (provider === "gemini") {
    return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  }
  if (provider === "anthropic") {
    return (data.content || []).map((p) => p.text || "").join("").trim();
  }
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function handleAiProxy(req, res) {
  const raw = await readBody(req);
  let payload;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { return sendJson(res, 400, { error: "Invalid request body" }); }
  const { provider = "openai", key, model, system, prompt, image } = payload;
  const base = String(payload.base || "").replace(/\/$/, "");
  if (!key) return sendJson(res, 400, { error: "Missing API key" });
  if (!prompt) return sendJson(res, 400, { error: "Missing prompt" });
  const maxTokens = Math.min(Math.max(Number(payload.maxTokens) || 1024, 64), 8192);
  const temperature = Number.isFinite(payload.temperature) ? payload.temperature : 0.2;

  let url, headers, body;
  if (provider === "gemini") {
    url = `${base || "https://generativelanguage.googleapis.com/v1beta"}/models/${encodeURIComponent(model || "gemini-1.5-flash")}:generateContent?key=${encodeURIComponent(key)}`;
    headers = { "Content-Type": "application/json" };
    const parts = [{ text: `${system ? system + "\n\n" : ""}${prompt}` }];
    if (image) parts.push({ inline_data: { mime_type: "image/jpeg", data: image } });
    body = { contents: [{ parts }], generationConfig: { temperature } };
  } else if (provider === "anthropic" || provider === "claude") {
    url = `${base || "https://api.anthropic.com/v1"}/messages`;
    headers = { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
    const content = image
      ? [{ type: "text", text: prompt }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } }]
      : prompt;
    body = { model: model || "claude-sonnet-5", max_tokens: maxTokens, messages: [{ role: "user", content }] };
    if (system) body.system = system;
  } else {
    url = `${base || "https://api.openai.com/v1"}/chat/completions`;
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
    const content = image
      ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }]
      : prompt;
    const messages = system ? [{ role: "system", content: system }, { role: "user", content }] : [{ role: "user", content }];
    body = { model: model || "gpt-4o-mini", messages, temperature };
  }

  try {
    await assertPublicHttps(url);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  let upstream;
  try {
    upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (error) {
    return sendJson(res, 502, { error: `Could not reach the AI provider: ${error.message}` });
  }
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const detail = data?.error?.message || data?.error?.toString?.() || data?.message || `Provider error ${upstream.status}`;
    return sendJson(res, upstream.status, { error: detail });
  }
  const text = extractText(provider, data);
  return sendJson(res, 200, { ok: true, provider, model, text });
}

// Lists the model IDs the given key can use - also doubles as a connection test.
async function handleAiModels(req, res) {
  const raw = await readBody(req);
  let payload;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { return sendJson(res, 400, { error: "Invalid request body" }); }
  const { provider = "openai", key } = payload;
  const base = String(payload.base || "").replace(/\/$/, "");
  if (!key) return sendJson(res, 400, { error: "Missing API key" });

  let url, headers;
  if (provider === "gemini") {
    url = `${base || "https://generativelanguage.googleapis.com/v1beta"}/models?key=${encodeURIComponent(key)}`;
    headers = {};
  } else if (provider === "anthropic" || provider === "claude") {
    url = `${base || "https://api.anthropic.com/v1"}/models`;
    headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
  } else {
    url = `${base || "https://api.openai.com/v1"}/models`;
    headers = { Authorization: `Bearer ${key}` };
  }
  try {
    await assertPublicHttps(url);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  let upstream;
  try {
    upstream = await fetch(url, { headers });
  } catch (error) {
    return sendJson(res, 502, { error: `Could not reach the AI provider: ${error.message}` });
  }
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const detail = data?.error?.message || data?.error?.toString?.() || data?.message || `Provider error ${upstream.status}`;
    return sendJson(res, upstream.status, { error: detail });
  }
  // OpenAI/xAI/Anthropic: {data:[{id}]}. Gemini: {models:[{name}]}.
  const list = data.data || data.models || [];
  const models = list.map((m) => (m.id || m.name || "").replace(/^models\//, "")).filter(Boolean).sort();
  return sendJson(res, 200, { ok: true, provider, models });
}

// --------------------------------------------------------------------------- //
// Route handlers
// --------------------------------------------------------------------------- //
function pickUpload(files) {
  return files.file || files.upload || Object.values(files)[0];
}

async function handleOfficeConvert(req, res) {
  const body = await readBody(req);
  const { files } = parseMultipart(req, body);
  const upload = pickUpload(files);
  if (!upload) return sendJson(res, 400, { error: "No file uploaded" });
  const ext = officeExt(upload.filename);
  await withTemp(async (dir) => {
    const inputName = safeName(upload.filename, `input.${ext || "docx"}`);
    const input = path.join(dir, inputName);
    const output = path.join(dir, `${path.parse(inputName).name}.pdf`);
    fs.writeFileSync(input, upload.data);
    let report;
    if (ext === "html" || ext === "htm") {
      report = await runHtmlToPdf(input, output, dir);
    } else {
      report = await runOfficeToPdf(input, output, dir);
    }
    sendFile(res, output, `${path.parse(inputName).name}.pdf`, MIME.pdf, report);
  });
}

// POST /api/native/ocr
// multipart: file (PDF or image) + page, lang, backend, dpi, forceOcr
// -> JSON { ok, engine, width, height, words:[{text,confidence,bbox}], lines, text }
//
// Unlike every other engine route this returns DATA, not a file: the editor
// turns each word box into an editable text box, so it needs the geometry,
// not a rendered artifact. The engine writes the full result to a temp JSON
// file (a dense page is thousands of boxes - too much for the one-line stdout
// status channel), and this reads it back.
async function handleOcr(req, res) {
  const body = await readBody(req);
  const { fields, files } = parseMultipart(req, body);
  const upload = pickUpload(files);
  if (!upload) return sendJson(res, 400, { error: "No file uploaded" });
  await withTemp(async (dir) => {
    const inputName = safeName(upload.filename, "input.pdf");
    const input = path.join(dir, inputName);
    const output = path.join(dir, "ocr.json");
    fs.writeFileSync(input, upload.data);
    const args = ["--input", input, "--output", output, "--lang", fields.lang || "eng"];
    if (fields.page) args.push("--page", String(parseInt(fields.page, 10) || 1));
    if (fields.backend) args.push("--backend", fields.backend);
    if (fields.dpi) args.push("--dpi", String(parseInt(fields.dpi, 10) || 0));
    if (fields.forceOcr === "1") args.push("--force-ocr");
    if (fields.minConfidence) args.push("--min-confidence", String(Number(fields.minConfidence) || 0));
    try {
      const report = await runEngine("ocr", args);
      if (!exists(output)) return sendJson(res, 500, { error: "OCR produced no result" });
      const result = JSON.parse(fs.readFileSync(output, "utf8"));
      sendJson(res, 200, { ...result, report });
    } catch (error) {
      // An unsupported language is a routing fact, not a failure: the browser
      // engine can still fetch that traineddata. 422 + the flag lets the
      // front-end fall back silently instead of showing an error.
      const unsupported = Boolean(error.report && error.report.unsupportedLanguage);
      sendJson(res, unsupported ? 422 : 500, {
        error: error.message,
        unsupportedLanguage: unsupported,
        languages: (error.report && error.report.languages) || [],
      });
    }
  });
}

// Real, local document intelligence (TextRank summary + keywords + entities
// + readability) - no AI API key needed. Returns JSON directly, not a file.
async function handleSummarize(req, res) {
  const body = await readBody(req);
  const { fields, files } = parseMultipart(req, body);
  const upload = pickUpload(files);
  if (!upload) return sendJson(res, 400, { error: "No PDF uploaded" });
  await withTemp(async (dir) => {
    const input = path.join(dir, safeName(upload.filename, "input.pdf"));
    fs.writeFileSync(input, upload.data);
    const args = ["--input", input];
    if (fields.sentences) args.push("--sentences", String(parseInt(fields.sentences, 10) || 6));
    try {
      const report = await runEngine("summarize", args);
      sendJson(res, 200, report);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });
}

function makePdfHandler({ command, ext, mime, buildArgs }) {
  return async (req, res) => {
    const body = await readBody(req);
    const { fields, files } = parseMultipart(req, body);
    const upload = pickUpload(files);
    if (!upload) return sendJson(res, 400, { error: "No PDF uploaded" });
    await withTemp(async (dir) => {
      const inputName = safeName(upload.filename, "input.pdf");
      const stem = path.parse(inputName).name;
      const input = path.join(dir, inputName);
      const output = path.join(dir, `${stem}-${command}.${ext}`);
      fs.writeFileSync(input, upload.data);
      const args = ["--input", input, "--output", output, ...buildArgs(fields, stem)];
      try {
        const report = await runEngine(command, args);
        if (!exists(output)) return sendJson(res, 500, { error: `${command} produced no file` });
        sendFile(res, output, `${stem}-${command}.${ext}`, mime, report);
      } catch (error) {
        const status = error.needsPassword ? 401 : 500;
        sendJson(res, status, { error: error.message, needsPassword: error.needsPassword });
      }
    });
  };
}

const handleCompress = makePdfHandler({
  command: "compress", ext: "pdf", mime: MIME.pdf,
  buildArgs: (fields) => ["--level", fields.level || "medium"],
});
const handleRepair = makePdfHandler({ command: "repair", ext: "pdf", mime: MIME.pdf, buildArgs: () => [] });
const handleUnlock = makePdfHandler({
  command: "unlock", ext: "pdf", mime: MIME.pdf,
  buildArgs: (fields) => (fields.password ? ["--password", fields.password] : []),
});
const handleProtect = makePdfHandler({
  command: "protect", ext: "pdf", mime: MIME.pdf,
  buildArgs: (fields) => {
    const args = ["--password", fields.password || ""];
    if (fields.ownerPassword) args.push("--owner-password", fields.ownerPassword);
    if (fields.noPrint === "1") args.push("--no-print");
    if (fields.noCopy === "1") args.push("--no-copy");
    if (fields.noEdit === "1") args.push("--no-edit");
    return args;
  },
});
const handlePdfA = makePdfHandler({
  command: "pdfa", ext: "pdf", mime: MIME.pdf,
  buildArgs: (fields) => (fields.title ? ["--title", fields.title] : []),
});
const handlePdfToImages = makePdfHandler({
  command: "pdf-to-images", ext: "zip", mime: MIME.zip,
  buildArgs: (fields, stem) => [
    "--dpi", String(fields.dpi || 200),
    "--img-format", fields.format || "png",
    "--quality", String(fields.quality || 88),
    "--stem", stem,
  ],
});
// Whole-document OCR: same PDF back, with an invisible (render-mode-3) text
// layer over the scan, so Ctrl+F and copy work everywhere afterwards.
const handleOcrPdf = makePdfHandler({
  command: "ocr-pdf", ext: "pdf", mime: MIME.pdf,
  buildArgs: (fields) => {
    const args = ["--lang", fields.lang || "eng"];
    if (fields.backend) args.push("--backend", fields.backend);
    if (fields.dpi) args.push("--dpi", String(parseInt(fields.dpi, 10) || 0));
    if (fields.pages) args.push("--pages", fields.pages);
    if (fields.page) args.push("--page", String(parseInt(fields.page, 10) || 1));
    if (fields.forceOcr === "1") args.push("--force-ocr");
    return args;
  },
});
const handlePdfToExcel = makePdfHandler({ command: "pdf-to-excel", ext: "xlsx", mime: MIME.xlsx, buildArgs: () => [] });
const handlePdfToWord = makePdfHandler({ command: "pdf-to-word", ext: "docx", mime: MIME.docx, buildArgs: () => [] });
const handlePdfToPpt = makePdfHandler({
  command: "pdf-to-ppt", ext: "pptx", mime: MIME.pptx,
  buildArgs: (fields) => ["--dpi", String(fields.dpi || 150)],
});
const handleRemoveWatermark = makePdfHandler({
  command: "remove-watermark", ext: "pdf", mime: MIME.pdf,
  buildArgs: (fields) => {
    const args = ["--mode", fields.mode || "auto"];
    if (fields.text) args.push("--text", fields.text);
    if (fields.pages) args.push("--pages", fields.pages);
    if (fields.page) args.push("--page", String(fields.page));
    if (fields.rect) {
      const parts = String(fields.rect).split(",").map((v) => v.trim());
      if (parts.length === 4) args.push("--rect", ...parts);
    }
    return args;
  },
});
// True redaction: strips the text/images/vector art under each box (not a
// painted-over rectangle). The editor's "Redact" tool draws a black box for
// instant visual feedback, but export routes the same boxes through here so
// the underlying content is actually gone, not just covered.
const handleRedactRegions = makePdfHandler({
  command: "redact-regions", ext: "pdf", mime: MIME.pdf,
  buildArgs: (fields) => {
    if (!fields.regions) throw Object.assign(new Error("No redaction regions supplied"), { status: 400 });
    return ["--regions-json", fields.regions];
  },
});

// --------------------------------------------------------------------------- //
// Organize: split / extract / rotate / delete / reorder (single input) + merge
// --------------------------------------------------------------------------- //
const handleSplit = makePdfHandler({
  command: "split", ext: "zip", mime: MIME.zip,
  buildArgs: (fields, stem) => {
    const args = ["--stem", stem];
    if (fields.ranges) args.push("--ranges", fields.ranges);
    else if (fields.every) args.push("--every", String(fields.every));
    return args;
  },
});
const handleExtract = makePdfHandler({
  command: "extract", ext: "pdf", mime: MIME.pdf,
  buildArgs: (fields) => (fields.ranges ? ["--ranges", fields.ranges] : []),
});
const handleRotate = makePdfHandler({
  command: "rotate", ext: "pdf", mime: MIME.pdf,
  buildArgs: (fields) => {
    const args = ["--angle", String(fields.angle || 90)];
    if (fields.ranges) args.push("--ranges", fields.ranges);
    return args;
  },
});
const handleDelete = makePdfHandler({
  command: "delete", ext: "pdf", mime: MIME.pdf,
  buildArgs: (fields) => (fields.ranges ? ["--ranges", fields.ranges] : []),
});
const handleReorder = makePdfHandler({
  command: "reorder", ext: "pdf", mime: MIME.pdf,
  buildArgs: (fields) => (fields.order ? ["--order", fields.order] : []),
});

// Merge takes several uploads. The client sends them as separate parts (any
// field names); we merge in ascending field-name order, so file0, file1, ...
// (or a, b, c) controls the sequence.
async function handleMerge(req, res) {
  const body = await readBody(req);
  const { files } = parseMultipart(req, body);
  const keys = Object.keys(files).sort();
  if (keys.length < 2) return sendJson(res, 400, { error: "Merge needs at least two PDFs" });
  await withTemp(async (dir) => {
    const paths = [];
    keys.forEach((k, i) => {
      const name = safeName(files[k].filename, `part-${i}.pdf`);
      const p = path.join(dir, `${String(i).padStart(3, "0")}-${name}`);
      fs.writeFileSync(p, files[k].data);
      paths.push(p);
    });
    const output = path.join(dir, "merged.pdf");
    const args = ["--inputs-json", JSON.stringify(paths), "--output", output];
    try {
      const report = await runEngine("merge", args);
      if (!exists(output)) return sendJson(res, 500, { error: "merge produced no file" });
      sendFile(res, output, "merged.pdf", MIME.pdf, report);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });
}

// Real page-aligned, word-level diff (see cmd_compare in engine.py) - not the
// old browser-only bag-of-words comparer. Takes two uploads: "fileA" (the
// original) and "fileB" (the new version).
async function handleCompare(req, res) {
  const body = await readBody(req);
  const { files } = parseMultipart(req, body);
  const fileA = files.fileA || files.file0 || Object.values(files)[0];
  const fileB = files.fileB || files.file1 || Object.values(files)[1];
  if (!fileA || !fileB) return sendJson(res, 400, { error: "Compare needs two PDFs (fileA and fileB)" });
  await withTemp(async (dir) => {
    const nameA = safeName(fileA.filename, "a.pdf");
    const nameB = safeName(fileB.filename, "b.pdf");
    const pathA = path.join(dir, `a-${nameA}`);
    const pathB = path.join(dir, `b-${nameB}`);
    fs.writeFileSync(pathA, fileA.data);
    fs.writeFileSync(pathB, fileB.data);
    const output = path.join(dir, "compare-result.pdf");
    const args = ["--input", pathA, "--input2", pathB, "--output", output];
    try {
      const report = await runEngine("compare", args);
      if (!exists(output)) return sendJson(res, 500, { error: "compare produced no file" });
      sendFile(res, output, "compare-result.pdf", MIME.pdf, report);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });
}

// --------------------------------------------------------------------------- //
// PDF password recovery (open-password brute force / dictionary attack)
//
// Every other tool in this file is a single blocking request: spawn engine.py,
// wait for it to exit, respond. This is the first genuinely long-running job
// (seconds to minutes), so it needs its own model: start a detached child,
// track it in an in-memory job map, and let the client poll for progress
// instead of holding one HTTP request open the whole time.
// --------------------------------------------------------------------------- //
function activeCrackJobCount() {
  let n = 0;
  for (const job of crackJobs.values()) if (job.status === "running" || job.status === "starting") n++;
  return n;
}

function sweepCrackJobs() {
  const now = Date.now();
  for (const [id, job] of crackJobs) {
    if (job.finishedAt && now - job.finishedAt > CRACK_JOB_TTL_MS) {
      if (job.tempDir) fs.rm(job.tempDir, { recursive: true, force: true }, () => {});
      crackJobs.delete(id);
    }
  }
}
setInterval(sweepCrackJobs, 5 * 60 * 1000).unref?.();

// engine.py's normal emit() prints exactly one JSON line and exits - fine for
// every other command. This job also prints incremental
// `{"type":"progress",...}` lines (newline-terminated) while it runs, with
// the final result as the last, newline-less line (emit()'s own behavior).
// runCapture() can't be reused here: it only resolves once the whole process
// closes, discarding everything but the last line - exactly what we need to
// avoid for progress to be visible mid-run.
function spawnCrackJob(job, extraArgs) {
  const caps = detectCapabilities();
  if (!caps.python) throw new Error("Python was not found on this machine.");
  const args = [...caps.python.args, ENGINE_PY, "pdf-crack", ...extraArgs];
  const child = spawn(caps.python.cmd, args, {
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  job.child = child;
  job.status = "running";
  let buffer = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed.type === "progress") {
        job.attempts = parsed.attempts;
        job.total = parsed.total;
        job.elapsedSeconds = parsed.elapsedSeconds;
      } else {
        job.result = parsed;
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", (error) => {
    job.status = "error";
    job.error = String(error.message);
    job.finishedAt = Date.now();
  });
  child.on("close", (code) => {
    // emit()'s final line has no trailing newline, so it's still sitting
    // unparsed in `buffer` when the stream closes - parse it here.
    const trailing = buffer.trim();
    if (trailing) {
      try { job.result = JSON.parse(trailing); } catch { /* leave prior job.result, if any */ }
    }
    if (job.status === "cancelling") {
      job.status = "cancelled";
    } else if (job.result && job.result.ok !== false) {
      job.status = "done";
    } else {
      job.status = "error";
      job.error = (job.result && job.result.error) || stderr.trim() || `crack process exited with code ${code}`;
    }
    job.finishedAt = Date.now();
  });
}

async function handleCrackStart(req, res) {
  if (activeCrackJobCount() >= MAX_CONCURRENT_CRACK_JOBS) {
    return sendJson(res, 429, {
      error: "The password recovery engine is already busy with another job on this server. Please try again shortly.",
    });
  }
  const body = await readBody(req);
  const { fields, files } = parseMultipart(req, body);
  const upload = pickUpload(files);
  if (!upload) return sendJson(res, 400, { error: "No PDF uploaded" });
  const mode = fields.mode || "pin";
  if (!["pin", "dictionary", "charset"].includes(mode)) {
    return sendJson(res, 400, { error: "Invalid recovery mode" });
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-pdf-crack-"));
  const inputName = safeName(upload.filename, "input.pdf");
  const input = path.join(dir, inputName);
  fs.writeFileSync(input, upload.data);

  const maxSeconds = Math.max(5, Math.min(Number(fields.maxSeconds) || 120, CRACK_JOB_MAX_SECONDS));
  const args = ["--input", input, "--crack-mode", mode, "--max-seconds", String(maxSeconds)];
  if (mode === "pin") {
    args.push("--min-len", String(Math.max(1, Math.min(12, Number(fields.minLen) || 4))));
    args.push("--max-len", String(Math.max(1, Math.min(12, Number(fields.maxLen) || 8))));
  } else if (mode === "charset") {
    if (fields.charset) args.push("--charset", fields.charset);
    args.push("--min-len", String(Math.max(1, Math.min(10, Number(fields.minLen) || 1))));
    args.push("--max-len", String(Math.max(1, Math.min(10, Number(fields.maxLen) || 4))));
  } else if (mode === "dictionary" && files.wordlist) {
    const wordlistPath = path.join(dir, "wordlist.txt");
    fs.writeFileSync(wordlistPath, files.wordlist.data);
    args.push("--wordlist", wordlistPath);
  }

  const jobId = crypto.randomUUID();
  const job = {
    status: "starting", attempts: 0, total: null, elapsedSeconds: 0,
    result: null, error: null, child: null, tempDir: dir,
    createdAt: Date.now(), finishedAt: null,
  };
  crackJobs.set(jobId, job);
  try {
    spawnCrackJob(job, args);
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    job.finishedAt = Date.now();
  }
  sendJson(res, 200, { jobId, maxSeconds });
}

function crackJobIdFromUrl(req) {
  const match = (req.url || "").match(/[?&]id=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function handleCrackStatus(req, res) {
  const job = crackJobs.get(crackJobIdFromUrl(req));
  if (!job) return sendJson(res, 404, { error: "Unknown or expired job" });
  const done = job.status === "done" || job.status === "error" || job.status === "cancelled";
  sendJson(res, 200, {
    status: job.status,
    attempts: job.attempts,
    total: job.total,
    elapsedSeconds: job.elapsedSeconds,
    result: done ? job.result : null,
    error: job.error,
  });
}

async function handleCrackCancel(req, res) {
  const job = crackJobs.get(crackJobIdFromUrl(req));
  if (!job) return sendJson(res, 404, { error: "Unknown or expired job" });
  if (job.child && job.status === "running") {
    job.status = "cancelling";
    job.child.kill();
  }
  sendJson(res, 200, { ok: true });
}

// --------------------------------------------------------------------------- //
// Static file serving (production: serve the built front-end)
// --------------------------------------------------------------------------- //
function serveStatic(req, res, url) {
  const clean = decodeURIComponent(url.split("?")[0]);
  let rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  // prevent path traversal
  const target = path.normalize(path.join(DIST_DIR, rel));
  if (!target.startsWith(DIST_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.stat(target, (err, stat) => {
    if (!err && stat.isFile()) {
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        "Content-Type": STATIC_MIME[ext] || "application/octet-stream",
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      });
      return fs.createReadStream(target).pipe(res);
    }
    // SPA fallback -> index.html
    const indexPath = path.join(DIST_DIR, "index.html");
    fs.readFile(indexPath, (e, data) => {
      if (e) {
        res.writeHead(404);
        return res.end("Not found");
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(data);
    });
  });
}

// --------------------------------------------------------------------------- //
// Server
// --------------------------------------------------------------------------- //
const API_ROUTES = {
  "POST /api/native/office-to-pdf": handleOfficeConvert,
  "POST /api/native/html-to-pdf": handleOfficeConvert,
  "POST /api/native/compress": handleCompress,
  "POST /api/native/repair": handleRepair,
  "POST /api/native/unlock": handleUnlock,
  "POST /api/native/protect": handleProtect,
  "POST /api/native/pdfa": handlePdfA,
  "POST /api/native/ocr": handleOcr,
  "POST /api/native/ocr-pdf": handleOcrPdf,
  "POST /api/native/pdf-to-images": handlePdfToImages,
  "POST /api/native/pdf-to-excel": handlePdfToExcel,
  "POST /api/native/pdf-to-word": handlePdfToWord,
  "POST /api/native/pdf-to-ppt": handlePdfToPpt,
  "POST /api/native/remove-watermark": handleRemoveWatermark,
  "POST /api/native/redact-regions": handleRedactRegions,
  "POST /api/native/photo-watermark-remove": handlePhotoWatermarkRemove,
  "POST /api/native/background-remove": handleBgRemove,
  "POST /api/native/merge": handleMerge,
  "POST /api/native/compare": handleCompare,
  "POST /api/native/summarize": handleSummarize,
  "POST /api/native/split": handleSplit,
  "POST /api/native/extract": handleExtract,
  "POST /api/native/rotate": handleRotate,
  "POST /api/native/delete": handleDelete,
  "POST /api/native/reorder": handleReorder,
  "POST /api/native/ai": handleAiProxy,
  "POST /api/native/ai-models": handleAiModels,
  "POST /api/native/pdf-crack/start": handleCrackStart,
  "GET /api/native/pdf-crack/status": handleCrackStatus,
  "POST /api/native/pdf-crack/cancel": handleCrackCancel,
};

const server = http.createServer(async (req, res) => {
  // If a request body is left partially unread (e.g. an oversized-upload
  // rejection responded to before the client finished streaming), tear the
  // connection down only AFTER the response has actually gone out - not
  // before, which would race the response write and drop it (see readBody).
  res.on("finish", () => { if (!req.destroyed) req.destroy(); });
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  const url = (req.url || "").split("?")[0];
  try {
    if (req.method === "GET" && url === "/api/native/status") {
      const force = (req.url || "").includes("refresh=1");
      return sendJson(res, 200, capabilitySummary(force));
    }
    if (req.method === "GET" && (url === "/healthz" || url === "/api/native/health")) {
      return sendJson(res, 200, { ok: true });
    }
    if (url === "/api/native/ai" || url === "/api/native/ai-models") {
      const { allowed, retryAfterSec } = aiRateLimiter.take(clientIp(req));
      if (!allowed) {
        res.writeHead(429, corsHeaders({ "Content-Type": MIME.json, "Retry-After": String(retryAfterSec) }));
        return res.end(JSON.stringify({ error: "Too many AI requests. Please wait a moment and try again." }));
      }
    }
    if (COMPUTE_HEAVY_ROUTES.has(url)) {
      const { allowed, retryAfterSec } = computeRateLimiter.take(clientIp(req));
      if (!allowed) {
        res.writeHead(429, corsHeaders({ "Content-Type": MIME.json, "Retry-After": String(retryAfterSec) }));
        return res.end(JSON.stringify({ error: "Too many requests to a compute-intensive tool. Please wait a moment and try again." }));
      }
    }
    const handler = API_ROUTES[`${req.method} ${url}`];
    if (handler) return await handler(req, res);
    if (req.method === "GET" && SERVE_STATIC) return serveStatic(req, res, req.url || "/");
    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return sendJson(res, error.status || 500, { error: error.message || "Native engine failed" });
  }
});

server.listen(PORT, BIND, () => {
  const summary = capabilitySummary(true);
  console.log(`Local PDF Studio engine listening at http://${BIND}:${PORT}${SERVE_STATIC ? " (serving built app)" : ""}`);
  console.log(`Python: ${summary.pythonVersion || "not found"} | PyMuPDF: ${summary.pymupdf} | pikepdf: ${summary.pikepdf} | pdf2docx: ${summary.pdf2docx}`);
  console.log(`Office->PDF: ${summary.officeEngine || "unavailable"} | HTML->PDF: ${summary.htmlEngine || "unavailable"}`);
});
