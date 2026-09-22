<p align="center">
  <img src="assets/hero.svg" alt="PDF Studio" width="100%">
</p>

<h1 align="center">PDF Studio</h1>

<p align="center">
  <b>A full PDF editor and toolbox that runs in your browser</b> — backed by a real, self-hosted engine so nothing is ever uploaded to a third-party service.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/local--first-e76f51?style=for-the-badge&logo=files&logoColor=white" alt="local-first">
  <img src="https://img.shields.io/badge/React-20232a?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React">
  <img src="https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite">
  <img src="https://img.shields.io/badge/Python_engine-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python">
  <img src="https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker">
</p>

---

## ✨ What it does

The interface is themed as **"Paper Studio"** — a warm kraft-paper desk with a floating cream sheet that unfolds from a tossed paper ball on first load. Behind that calm surface is a serious engine: heavy, professional-grade operations run **server-side in one Docker container** (LibreOffice + Chromium + Python), so a visitor needs nothing installed and no file ever leaves your server.

| | | |
|---|---|---|
| 📝 **Edit** text, shapes, notes, redactions | 🔍 **OCR** in 27 languages (PP-OCRv4 → Tesseract) | 🗜️ **Compress** — content-aware, 4 levels |
| 🔄 **Convert** to/from Word, Excel, PowerPoint, images | 🔒 **Unlock / protect** with real AES-256 (pikepdf) | 🩹 **Repair** damaged PDFs |
| 🧩 **Merge · split · reorder · rotate** pages | 🖼️ **Photo Studio** — crop, resize, watermark, bg-removal | 🔑 **Recover PDF passwords** (PIN / dictionary / brute-force) |
| ✂️ **True redaction** — content removed, not just covered | 📐 **PDF/A** archival export | 🧠 **AI summarize** (bring your own key) |

Every tool has a **browser fallback** and a **professional-engine** path — the app shows you which one is running, and degrades gracefully when the engine is off.

## 🚀 Run it

Install once, then run the app **and** the engine together:

```bash
npm install
npm run dev:full
```

Open **http://127.0.0.1:5173**. Prefer two terminals?

```bash
npm run engine              # the Python/Node professional engine
npm run dev -- --port 5173  # the Vite front-end
```

## 🐳 Deploy

One container serves the built front-end **and** the engine. Full walkthrough in **[DEPLOY.md](DEPLOY.md)** — point a domain at a small VPS, `docker compose up -d --build`, and Caddy fetches HTTPS automatically.

```bash
cp .env.example .env        # set SITE_ADDRESS=pdf.yourdomain.com
docker compose up -d --build
```

## 🏗️ How it's built

```
React + Vite (src/App.jsx)  ─────────────┐
                                          │  same-origin /api/native/*
  engine-server.cjs  ◀── Node HTTP bridge ┘
        │  spawns per request
        ▼
  engine.py  ── PyMuPDF · pikepdf · pdf2docx · RapidOCR (ONNX) · Tesseract · qpdf
  + LibreOffice (Office→PDF)  + Chromium (HTML→PDF)
```

- **Front-end:** React 19 + Vite 7, pdf.js for rendering, pdf-lib for in-browser edits.
- **Engine:** a single Python CLI (`engine.py`) the Node bridge shells out to — every command reads real files and prints a one-line JSON status. Optional libraries degrade gracefully instead of crashing.
- **Privacy:** uploads are processed in a temp folder and deleted immediately after each request; nothing is stored.

## 🔐 Notes

- Large OCR/background-removal ONNX model weights (~366 MB) are **not** committed here — they live in `engine/models/` locally. See `requirements.txt` and `DEPLOY.md` for the runtime setup that provides them.
- `.env` is git-ignored; only `.env.example` (placeholders) ships.

---

<p align="center"><sub>Built as a free, local-first alternative to the upload-everything PDF sites. Your documents stay yours.</sub></p>
