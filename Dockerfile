# syntax=docker/dockerfile:1
# ============================================================
# Local PDF Studio - hosted image
# One container that serves the built front-end AND the engine,
# using LibreOffice (Office -> PDF), Chromium (HTML -> PDF), and
# Python/PyMuPDF/pikepdf for everything else. Fully cross-platform.
# ============================================================

# ---- Stage 1: build the front-end -------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
# Same-origin engine in production (served by the Node server).
ENV VITE_ENGINE_BASE=""
RUN npm run build

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHON_BIN=/usr/bin/python3 \
    PORT=8080 \
    SERVE_STATIC=1 \
    NODE_ENV=production

# System deps: Python + LibreOffice (Writer/Calc/Impress) + fonts + Tesseract.
# Tesseract is the SECOND OCR tier: the bundled PP-OCRv4 model only covers
# Latin + CJK, so every other script in the editor's language menu (Hindi,
# Bengali, Tamil, Arabic, ...) needs one of these traineddata packages.
# Without them those languages fall all the way back to the browser engine,
# which has to download its own language data at runtime - the exact
# failure this work removed.
#
# LibreOffice handles Office -> PDF and HTML -> PDF reliably in headless Linux.
# (On a local Windows install the engine uses MS Office + Edge instead, and
# picks up a Tesseract binary if one is present; all are auto-detected.)
# Carlito/Caladea are metric-compatible with Calibri/Cambria for good docx output.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-core \
      fonts-liberation fonts-dejavu fonts-crosextra-carlito fonts-crosextra-caladea \
      libgl1 libglib2.0-0 fontconfig \
      tesseract-ocr \
      tesseract-ocr-hin tesseract-ocr-ben tesseract-ocr-tam tesseract-ocr-tel \
      tesseract-ocr-mar tesseract-ocr-guj tesseract-ocr-urd \
      tesseract-ocr-spa tesseract-ocr-fra tesseract-ocr-deu tesseract-ocr-por \
      tesseract-ocr-ita tesseract-ocr-nld tesseract-ocr-pol tesseract-ocr-tur \
      tesseract-ocr-rus tesseract-ocr-ara tesseract-ocr-tha tesseract-ocr-vie \
      tesseract-ocr-chi-sim tesseract-ocr-chi-tra tesseract-ocr-jpn tesseract-ocr-kor \
    && rm -rf /var/lib/apt/lists/*

# Python engine packages (isolated venv keeps it off the system interpreter).
COPY requirements.txt ./
# rapidocr-onnxruntime declares opencv-python (the GUI build) as a dependency;
# installing it with --no-deps keeps the headless OpenCV pinned above and
# saves the duplicate ~60 MB. Its real requirements are in requirements.txt,
# and its PP-OCRv4 models ship inside the wheel - nothing is fetched at
# runtime, so OCR works on a box with no outbound network.
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt \
    && /opt/venv/bin/pip install --no-cache-dir --no-deps --force-reinstall rapidocr-onnxruntime==1.4.4
ENV PYTHON_BIN=/opt/venv/bin/python

WORKDIR /app
COPY engine-server.cjs engine.py ./
# The photo-watermark engine (engine/watermark/photo_watermark.py) and small
# server modules (engine/rateLimiter.cjs) live under engine/ - engine/tests is
# excluded via .dockerignore, this is production code only.
COPY engine ./engine
COPY --from=build /app/dist ./dist

# Run as an unprivileged user.
RUN useradd -m appuser && mkdir -p /tmp/pdfstudio && chown -R appuser /app /tmp/pdfstudio
USER appuser

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "engine-server.cjs"]
