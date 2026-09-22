import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Brush,
  Contrast,
  Crop,
  Download,
  Eraser,
  FlipHorizontal2,
  FlipVertical2,
  ImagePlus,
  Maximize2,
  Printer,
  RotateCw,
  Ruler,
  Sparkles,
  Upload,
  Wand2,
} from "lucide-react";
import { callAi } from "./aiClient.js";
import { centeredCrop, clampRect } from "./lib/cropRect.js";
import { fitToSizeBudget, searchQualityForBudget } from "./lib/sizeBudgetSearch.js";
import { parseAiPhotoSettings } from "./lib/aiPhotoSettings.js";

const PHOTO_PRESETS = [
  { id: "free", label: "Free crop", hint: "Crop anything, output any size", aspect: null },
  { id: "square", label: "Square 1:1", hint: "Profile pictures, marketplaces", out: [1000, 1000], format: "jpeg" },
  { id: "in-passport", label: "India Passport / OCI", hint: "51 x 51 mm (2 x 2 in), white background", mm: [51, 51], dpi: 300, format: "jpeg", targetKB: 240 },
  { id: "us-passport", label: "US Passport / DS-160", hint: "2 x 2 in digital, 600 x 600 px", out: [600, 600], format: "jpeg", targetKB: 240 },
  { id: "schengen-visa", label: "Schengen / EU Visa", hint: "35 x 45 mm at 300 DPI", mm: [35, 45], dpi: 300, format: "jpeg" },
  { id: "uk-passport", label: "UK Passport / Visa", hint: "35 x 45 mm at 300 DPI", mm: [35, 45], dpi: 300, format: "jpeg" },
  { id: "govt-photo", label: "Govt exam photo", hint: "3.5 x 4.5 cm, 20-50 KB (SSC / UPSC style)", mm: [35, 45], dpi: 200, format: "jpeg", targetKB: 50 },
  { id: "govt-sign", label: "Govt exam signature", hint: "140 x 60 px, 10-20 KB", out: [140, 60], format: "jpeg", targetKB: 20 },
  { id: "pan-photo", label: "PAN / Aadhaar photo", hint: "25 x 35 mm, under 50 KB", mm: [25, 35], dpi: 300, format: "jpeg", targetKB: 50 },
  { id: "a4-doc", label: "A4 document", hint: "210 x 297 mm at 150 DPI", mm: [210, 297], dpi: 150, format: "jpeg" },
];

const PRINT_PAPERS = [
  { id: "4x6", label: "4 x 6 in sheet", w: 6, h: 4 },
  { id: "a4", label: "A4 sheet", w: 8.27, h: 11.69 },
];

const AI_PROVIDERS = {
  openai: {
    label: "ChatGPT / OpenAI",
    base: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  gemini: {
    label: "Gemini",
    base: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-1.5-flash",
  },
  claude: {
    label: "Claude",
    base: "https://api.anthropic.com/v1",
    model: "claude-3-5-sonnet-latest",
  },
  custom: {
    label: "Custom",
    base: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
};

const NATIVE_ENGINE_BASE =
  import.meta.env.VITE_ENGINE_BASE ?? (import.meta.env.DEV ? "http://127.0.0.1:5174" : "");

const clampNum = (value, min, max) => Math.min(max, Math.max(min, value));
const mmToPx = (mm, dpi) => Math.max(1, Math.round((mm / 25.4) * dpi));

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

// centeredCrop / clampRect now live in ./lib/cropRect.js (tested with a 500-case
// aspect/size fuzz check) so Photo Studio's crop, resize-to-exact-size, and
// passport/visa presets all share one verified implementation.

/* Stepped-halving downscale keeps small government-size outputs sharp
   instead of the muddy result a single drawImage jump produces. */
function drawScaled(source, sx, sy, sw, sh, tw, th, filter, bgColor, needsBg) {
  let cw = Math.max(1, Math.min(Math.round(sw), Math.max(tw * 4, 2048)));
  let ch = Math.max(1, Math.min(Math.round(sh), Math.max(th * 4, 2048)));
  let canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  let ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, cw, ch);
  while (cw / 2 >= tw && ch / 2 >= th) {
    cw = Math.max(tw, Math.floor(cw / 2));
    ch = Math.max(th, Math.floor(ch / 2));
    const next = document.createElement("canvas");
    next.width = cw;
    next.height = ch;
    const nextCtx = next.getContext("2d");
    nextCtx.imageSmoothingEnabled = true;
    nextCtx.imageSmoothingQuality = "high";
    nextCtx.drawImage(canvas, 0, 0, cw, ch);
    canvas = next;
  }
  const out = document.createElement("canvas");
  out.width = tw;
  out.height = th;
  const outCtx = out.getContext("2d");
  if (needsBg) {
    outCtx.fillStyle = bgColor;
    outCtx.fillRect(0, 0, tw, th);
  }
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "high";
  outCtx.filter = filter;
  outCtx.drawImage(canvas, 0, 0, tw, th);
  return out;
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

function canvasToDataUrl(canvas, mime = "image/jpeg", quality = 0.88) {
  return canvas.toDataURL(mime, quality);
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function healRectOnCanvas(canvas, rect, strength) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const W = canvas.width;
  const H = canvas.height;
  const x0 = clampNum(Math.round(rect.x), 0, W - 1);
  const y0 = clampNum(Math.round(rect.y), 0, H - 1);
  const x1 = clampNum(Math.round(rect.x + rect.w), x0 + 1, W);
  const y1 = clampNum(Math.round(rect.y + rect.h), y0 + 1, H);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 3 || h < 3) return;

  const source = ctx.getImageData(0, 0, W, H);
  const output = ctx.createImageData(source);
  output.data.set(source.data);
  const data = source.data;
  const out = output.data;
  const feather = Math.max(8, Math.round(Math.min(w, h) * 0.16));
  const ring = Math.max(2, Math.round(Math.min(W, H) * 0.004));
  const sample = (x, y) => {
    const xx = clampNum(Math.round(x), 0, W - 1);
    const yy = clampNum(Math.round(y), 0, H - 1);
    const i = (yy * W + xx) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const top = sample(x, y0 - ring);
      const bottom = sample(x, y1 + ring);
      const left = sample(x0 - ring, y);
      const right = sample(x1 + ring, y);
      const dxL = x - x0 + 1;
      const dxR = x1 - x + 1;
      const dyT = y - y0 + 1;
      const dyB = y1 - y + 1;
      const weights = [
        1 / dyT,
        1 / dyB,
        1 / dxL,
        1 / dxR,
      ];
      const total = weights.reduce((sum, value) => sum + value, 0);
      const fill = [0, 1, 2].map((channel) => (
        (top[channel] * weights[0]
          + bottom[channel] * weights[1]
          + left[channel] * weights[2]
          + right[channel] * weights[3]) / total
      ));
      const edgeDistance = Math.min(dxL, dxR, dyT, dyB);
      const edgeBlend = clampNum(edgeDistance / feather, 0, 1);
      const localStrength = strength * edgeBlend;
      const i = (y * W + x) * 4;
      out[i] = data[i] * (1 - localStrength) + fill[0] * localStrength;
      out[i + 1] = data[i + 1] * (1 - localStrength) + fill[1] * localStrength;
      out[i + 2] = data[i + 2] * (1 - localStrength) + fill[2] * localStrength;
    }
  }
  ctx.putImageData(output, 0, 0);
}

function removeEdgeBackgroundOnCanvas(canvas, sensitivity) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const W = canvas.width;
  const H = canvas.height;
  if (!ctx || !W || !H) return;
  const image = ctx.getImageData(0, 0, W, H);
  const data = image.data;
  const samplePoints = [
    [0, 0],
    [W - 1, 0],
    [0, H - 1],
    [W - 1, H - 1],
    [Math.floor(W / 2), 0],
    [Math.floor(W / 2), H - 1],
    [0, Math.floor(H / 2)],
    [W - 1, Math.floor(H / 2)],
  ];
  const bg = samplePoints.reduce(
    (sum, [x, y]) => {
      const i = (y * W + x) * 4;
      return { r: sum.r + data[i], g: sum.g + data[i + 1], b: sum.b + data[i + 2] };
    },
    { r: 0, g: 0, b: 0 },
  );
  bg.r /= samplePoints.length;
  bg.g /= samplePoints.length;
  bg.b /= samplePoints.length;

  const threshold = 22 + sensitivity * 150;
  const feather = 24 + sensitivity * 70;
  const closeToBackground = (index, extra = 0) => {
    const r = data[index] - bg.r;
    const g = data[index + 1] - bg.g;
    const b = data[index + 2] - bg.b;
    return Math.hypot(r, g, b) <= threshold + extra;
  };

  const seen = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0;
  let tail = 0;
  const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = y * W + x;
    if (seen[p]) return;
    const i = p * 4;
    if (!closeToBackground(i)) return;
    seen[p] = 1;
    queue[tail] = p;
    tail += 1;
  };

  for (let x = 0; x < W; x += 1) {
    enqueue(x, 0);
    enqueue(x, H - 1);
  }
  for (let y = 0; y < H; y += 1) {
    enqueue(0, y);
    enqueue(W - 1, y);
  }

  while (head < tail) {
    const p = queue[head];
    head += 1;
    const x = p % W;
    const y = Math.floor(p / W);
    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
  }

  for (let p = 0; p < seen.length; p += 1) {
    if (!seen[p]) continue;
    data[p * 4 + 3] = 0;
  }
  for (let y = 1; y < H - 1; y += 1) {
    for (let x = 1; x < W - 1; x += 1) {
      const p = y * W + x;
      if (seen[p]) continue;
      const i = p * 4;
      if (!closeToBackground(i, feather)) continue;
      const touchesBackground = seen[p - 1] || seen[p + 1] || seen[p - W] || seen[p + W];
      if (touchesBackground) data[i + 3] = Math.min(data[i + 3], 96);
    }
  }
  ctx.putImageData(image, 0, 0);
}

function PhotoStudio({ onBack, initialPresetId }) {
  const fileRef = useRef(null);
  const wrapRef = useRef(null);
  const previewRef = useRef(null);
  const workRef = useRef(null);
  const dragRef = useRef(null);

  const [img, setImg] = useState(null);
  const [srcInfo, setSrcInfo] = useState(null);
  const [workSize, setWorkSize] = useState({ w: 0, h: 0 });
  const [crop, setCrop] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const [aspect, setAspect] = useState(null);
  const [lockRatio, setLockRatio] = useState(true);
  const [presetId, setPresetId] = useState("free");
  const [rotation, setRotation] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [outW, setOutW] = useState(600);
  const [outH, setOutH] = useState(600);
  const [dpi, setDpi] = useState(300);
  const [format, setFormat] = useState("jpeg");
  const [quality, setQuality] = useState(0.92);
  const [targetKB, setTargetKB] = useState("");
  const [bg, setBg] = useState("#ffffff");
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturation, setSaturation] = useState(100);
  const [grayscale, setGrayscale] = useState(false);
  const [cleanupStrength, setCleanupStrength] = useState(0.82);
  const [backgroundSensitivity, setBackgroundSensitivity] = useState(0.48);
  const [authorizedWatermarkRemoval, setAuthorizedWatermarkRemoval] = useState(false);
  const [aiProvider, setAiProvider] = useState(() => sessionStorage.getItem("photoStudioAiProvider") || "openai");
  const [aiBase, setAiBase] = useState(() => sessionStorage.getItem("photoStudioAiBase") || AI_PROVIDERS.openai.base);
  const [aiKey, setAiKey] = useState(() => sessionStorage.getItem("photoStudioAiKey") || "");
  const [aiModel, setAiModel] = useState(() => sessionStorage.getItem("photoStudioAiModel") || AI_PROVIDERS.openai.model);
  const [aiPrompt, setAiPrompt] = useState("Enhance this image naturally for clarity, upload quality, and clean background.");
  const [aiAnswer, setAiAnswer] = useState("");
  const [estimate, setEstimate] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Open a photo of any size. Crop it, pick a preset or a custom size, and download an exact-size file.");
  const [version, setVersion] = useState(0);
  const [photoEngineAvailable, setPhotoEngineAvailable] = useState(false);
  const [bgRemovalAvailable, setBgRemovalAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${NATIVE_ENGINE_BASE}/api/native/status`);
        if (!response.ok) throw new Error("unavailable");
        const data = await response.json();
        if (!cancelled) {
          setPhotoEngineAvailable(Boolean(data?.features?.photoWatermark));
          setBgRemovalAvailable(Boolean(data?.features?.bgRemoval));
        }
      } catch {
        if (!cancelled) {
          setPhotoEngineAvailable(false);
          setBgRemovalAvailable(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Real segmentation (U2Net) when the engine is available - understands any
  // background, not just a flat colour, unlike the flood-fill fallback below.
  // Returns a canvas: RGBA transparent if bgColorHex is null, else composited
  // onto that solid colour. Throws on failure so callers can fall back.
  const runBgRemovalEngine = async (sourceCanvas, bgColorHex) => {
    const sourceBlob = await canvasToBlob(sourceCanvas, "image/png");
    if (!sourceBlob) throw new Error("Could not prepare the image for the engine");
    const form = new FormData();
    form.append("file", sourceBlob, "source.png");
    if (bgColorHex) form.append("bgColor", bgColorHex.replace(/^#/, ""));
    const response = await fetch(`${NATIVE_ENGINE_BASE}/api/native/background-remove`, {
      method: "POST", body: form,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `Engine request failed (${response.status})`);
    }
    const resultBlob = await response.blob();
    const bitmap = await createImageBitmap(resultBlob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    return canvas;
  };

  const cropRef = useRef(crop);
  cropRef.current = crop;
  const aspectRef = useRef(aspect);
  aspectRef.current = aspect;
  const workSizeRef = useRef(workSize);
  workSizeRef.current = workSize;

  const filterString = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)${grayscale ? " grayscale(1)" : ""}`;

  const openFile = (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setStatus("Choose an image file (PNG, JPG, or WEBP).");
      return;
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      setImg(image);
      setSrcInfo({
        name: file.name.replace(/\.[^.]+$/, "") || "photo",
        sizeKB: Math.max(1, Math.round(file.size / 1024)),
        w: image.naturalWidth,
        h: image.naturalHeight,
      });
      setRotation(0);
      setFlipH(false);
      setFlipV(false);
      setEstimate(null);
      setStatus(`${file.name} loaded (${image.naturalWidth} x ${image.naturalHeight} px, ${Math.round(file.size / 1024)} KB). Drag the crop box, then download.`);
    };
    image.onerror = () => setStatus("Could not read that image. Try PNG or JPG.");
    image.src = url;
  };

  useEffect(() => {
    const onPaste = (event) => {
      const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith("image/"));
      if (item) openFile(item.getAsFile());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const selectPreset = (id, currentWork = workSizeRef.current) => {
    const preset = PHOTO_PRESETS.find((entry) => entry.id === id) || PHOTO_PRESETS[0];
    setPresetId(preset.id);
    const nextDpi = preset.dpi || dpi;
    if (preset.dpi) setDpi(preset.dpi);
    let w = 0;
    let h = 0;
    if (preset.out) [w, h] = preset.out;
    else if (preset.mm) {
      w = mmToPx(preset.mm[0], nextDpi);
      h = mmToPx(preset.mm[1], nextDpi);
    }
    let nextAspect = preset.aspect ?? null;
    if (w && h) {
      setOutW(w);
      setOutH(h);
      nextAspect = w / h;
    }
    setAspect(nextAspect);
    setLockRatio(Boolean(nextAspect));
    if (preset.format) setFormat(preset.format);
    setTargetKB(preset.targetKB ? String(preset.targetKB) : "");
    if (currentWork.w) setCrop(centeredCrop(currentWork.w, currentWork.h, nextAspect));
    setStatus(`${preset.label}: ${preset.hint}. Position the crop box over the subject, then download.`);
  };

  useEffect(() => {
    if (initialPresetId) selectPreset(initialPresetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPresetId]);

  useEffect(() => {
    if (!img) return;
    const rotated = rotation % 180 !== 0;
    const W = rotated ? img.naturalHeight : img.naturalWidth;
    const H = rotated ? img.naturalWidth : img.naturalHeight;
    if (!workRef.current) workRef.current = document.createElement("canvas");
    const canvas = workRef.current;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    ctx.restore();
    setWorkSize({ w: W, h: H });
    setCrop(centeredCrop(W, H, aspectRef.current));
    setVersion((value) => value + 1);
  }, [img, rotation, flipH, flipV]);

  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || !workSize.w || !workRef.current) return;
    const scale = Math.min(1, 920 / workSize.w, 620 / workSize.h);
    canvas.width = Math.max(1, Math.round(workSize.w * scale));
    canvas.height = Math.max(1, Math.round(workSize.h * scale));
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(workRef.current, 0, 0, canvas.width, canvas.height);
  }, [workSize, version, img]);

  const pointInWork = (event) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const size = workSizeRef.current;
    return {
      x: clampNum(((event.clientX - rect.left) / rect.width) * size.w, 0, size.w),
      y: clampNum(((event.clientY - rect.top) / rect.height) * size.h, 0, size.h),
    };
  };

  const onDragMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const size = workSizeRef.current;
    const ratio = aspectRef.current;
    const point = pointInWork(event);
    if (drag.mode === "move") {
      const next = {
        ...drag.orig,
        x: clampNum(drag.orig.x + point.x - drag.start.x, 0, size.w - drag.orig.w),
        y: clampNum(drag.orig.y + point.y - drag.start.y, 0, size.h - drag.orig.h),
      };
      setCrop(next);
      return;
    }
    if (drag.mode === "new") {
      let w = Math.abs(point.x - drag.start.x);
      let h = Math.abs(point.y - drag.start.y);
      if (ratio) {
        if (h < 1 || w / h > ratio) h = w / ratio;
        else w = h * ratio;
      }
      const x = point.x >= drag.start.x ? drag.start.x : drag.start.x - w;
      const y = point.y >= drag.start.y ? drag.start.y : drag.start.y - h;
      setCrop(clampRect({ x, y, w, h }, size.w, size.h, ratio));
      return;
    }
    const { corner, orig, start } = drag;
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    let { x, y, w, h } = orig;
    if (corner.includes("e")) w = orig.w + dx;
    if (corner.includes("s")) h = orig.h + dy;
    if (corner.includes("w")) {
      x = orig.x + dx;
      w = orig.w - dx;
    }
    if (corner.includes("n")) {
      y = orig.y + dy;
      h = orig.h - dy;
    }
    w = Math.max(16, w);
    h = Math.max(16, h);
    if (ratio) {
      if (corner === "n" || corner === "s") w = h * ratio;
      else if (corner === "e" || corner === "w") h = w / ratio;
      else if (w / h > ratio) w = h * ratio;
      else h = w / ratio;
      if (corner.includes("w")) x = orig.x + orig.w - w;
      if (corner.includes("n")) y = orig.y + orig.h - h;
    }
    setCrop(clampRect({ x, y, w, h }, size.w, size.h, ratio));
  };

  const endDrag = () => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", endDrag);
  };

  const beginDrag = (mode, corner) => (event) => {
    if (!workSizeRef.current.w) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { mode, corner, start: pointInWork(event), orig: { ...cropRef.current } };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", endDrag);
  };

  const reshapeCropToAspect = (nextAspect) => {
    const size = workSizeRef.current;
    if (!size.w || !nextAspect) return;
    setCrop((current) => {
      const cx = current.x + current.w / 2;
      const cy = current.y + current.h / 2;
      let w = current.w;
      let h = w / nextAspect;
      if (h > size.h) {
        h = size.h;
        w = h * nextAspect;
      }
      if (w > size.w) {
        w = size.w;
        h = w / nextAspect;
      }
      return clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }, size.w, size.h, nextAspect);
    });
  };

  const setOutDimension = (axis, rawValue) => {
    const value = Math.max(1, Math.min(20000, Math.round(Number(rawValue) || 0)));
    if (!value) return;
    let w = outW;
    let h = outH;
    if (axis === "w") {
      w = value;
      setOutW(value);
    } else {
      h = value;
      setOutH(value);
    }
    setPresetId("custom");
    if (lockRatio && w > 0 && h > 0) {
      const nextAspect = w / h;
      setAspect(nextAspect);
      reshapeCropToAspect(nextAspect);
    }
  };

  const toggleLockRatio = () => {
    const next = !lockRatio;
    setLockRatio(next);
    if (next && outW > 0 && outH > 0) {
      const nextAspect = outW / outH;
      setAspect(nextAspect);
      reshapeCropToAspect(nextAspect);
    } else {
      setAspect(null);
    }
  };

  const useCropAsOutput = () => {
    if (!crop.w) return;
    setOutW(Math.max(1, Math.round(crop.w)));
    setOutH(Math.max(1, Math.round(crop.h)));
    setPresetId("custom");
    setStatus(`Output set to the crop's own pixels: ${Math.round(crop.w)} x ${Math.round(crop.h)} px.`);
  };

  const renderBlob = (blobQuality, tw, th) => {
    const mime = format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
    const canvas = drawScaled(
      workRef.current,
      crop.x,
      crop.y,
      Math.max(1, crop.w),
      Math.max(1, crop.h),
      Math.max(1, tw),
      Math.max(1, th),
      filterString,
      bg,
      format !== "png",
    );
    return new Promise((resolve) => canvas.toBlob(resolve, mime, blobQuality));
  };

  const buildCleanupCanvas = ({ healArea = false, maxSide = 0 } = {}) => {
    const source = workRef.current;
    if (!source || !workSize.w || !workSize.h) return null;
    const scale = maxSide ? Math.min(1, maxSide / Math.max(workSize.w, workSize.h)) : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(workSize.w * scale));
    canvas.height = Math.max(1, Math.round(workSize.h * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.filter = filterString;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    ctx.filter = "none";
    if (healArea && crop.w && crop.h) {
      healRectOnCanvas(
        canvas,
        { x: crop.x * scale, y: crop.y * scale, w: crop.w * scale, h: crop.h * scale },
        cleanupStrength,
      );
    }
    return canvas;
  };

  const exportEnhancedCopy = async () => {
    if (!img || !workRef.current) {
      setStatus("Open an image first.");
      return;
    }
    setBusy(true);
    try {
      const canvas = buildCleanupCanvas({ healArea: false });
      const mime = format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
      const blob = await canvasToBlob(canvas, mime, format === "png" ? undefined : quality);
      if (!blob) throw new Error("No enhanced image blob");
      const extension = format === "png" ? "png" : format === "webp" ? "webp" : "jpg";
      const name = `${srcInfo?.name || "photo"}-enhanced.${extension}`;
      downloadBlob(blob, name);
      setStatus(`Enhanced copy saved as ${name}. The original crop/resize setup was not changed.`);
    } catch (error) {
      console.error(error);
      setStatus("Could not create the enhanced copy.");
    } finally {
      setBusy(false);
    }
  };

  // Shared by Cleanup / Object Removal / Watermark Removal: all three are the
  // same operation - "reconstruct the crop-box area" - so they share one
  // engine call instead of three independently-drifting copies. Tries the
  // professional engine (matte inversion / inpainting) first; falls back to
  // the browser edge-blend fill, labeled honestly, only if the engine isn't
  // detected.
  const runAreaRepair = async ({ suffix, verb, notOpenMsg, failMsg }) => {
    if (!img || !workRef.current || !crop.w || !crop.h) {
      setStatus(notOpenMsg);
      return;
    }
    setBusy(true);
    try {
      const mime = format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
      const extension = format === "png" ? "png" : format === "webp" ? "webp" : "jpg";
      const name = `${srcInfo?.name || "photo"}-${suffix}.${extension}`;

      if (photoEngineAvailable) {
        const sourceCanvas = buildCleanupCanvas({ healArea: false });
        const sourceBlob = await canvasToBlob(sourceCanvas, "image/png");
        if (!sourceBlob) throw new Error("Could not prepare the image for the engine");
        const form = new FormData();
        form.append("file", sourceBlob, "source.png");
        form.append("x", String(Math.round(crop.x)));
        form.append("y", String(Math.round(crop.y)));
        form.append("w", String(Math.round(crop.w)));
        form.append("h", String(Math.round(crop.h)));
        const response = await fetch(`${NATIVE_ENGINE_BASE}/api/native/photo-watermark-remove`, {
          method: "POST", body: form,
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          throw new Error(detail.error || `Engine request failed (${response.status})`);
        }
        const resultBlob = await response.blob();
        const reportHeader = response.headers.get("X-Engine-Report");
        let confidence = null;
        if (reportHeader) {
          try { confidence = JSON.parse(decodeURIComponent(escape(atob(reportHeader))))?.confidence; } catch { /* ignore */ }
        }
        const bitmap = await createImageBitmap(resultBlob);
        const outCanvas = document.createElement("canvas");
        outCanvas.width = bitmap.width;
        outCanvas.height = bitmap.height;
        outCanvas.getContext("2d").drawImage(bitmap, 0, 0);
        const finalBlob = await canvasToBlob(outCanvas, mime, format === "png" ? undefined : quality);
        if (!finalBlob) throw new Error(`No ${suffix} image blob`);
        downloadBlob(finalBlob, name);
        const confText = Number.isFinite(confidence) ? ` (engine confidence ${Math.round(confidence * 100)}%)` : "";
        setStatus(`${verb} copy saved as ${name} using the professional engine${confText}.`);
        return;
      }

      const canvas = buildCleanupCanvas({ healArea: true });
      const blob = await canvasToBlob(canvas, mime, format === "png" ? undefined : quality);
      if (!blob) throw new Error(`No ${suffix} image blob`);
      downloadBlob(blob, name);
      setStatus(`${verb} copy saved as ${name} using the browser fallback (no professional engine detected - result may be softer over busy backgrounds).`);
    } catch (error) {
      console.error(error);
      setStatus(failMsg);
    } finally {
      setBusy(false);
    }
  };

  const exportCleanupCopy = () => runAreaRepair({
    suffix: "cleanup",
    verb: "Cleanup",
    notOpenMsg: "Open an image and put the crop box around the mark or damaged area first.",
    failMsg: "Could not repair that area. Try a smaller crop around only the mark/damage.",
  });

  const exportObjectRemovalCopy = () => runAreaRepair({
    suffix: "object-removed",
    verb: "Object removal",
    notOpenMsg: "Open an image and put the crop box tightly around the object first.",
    failMsg: "Could not remove that object cleanly. Try a tighter crop around only the object.",
  });

  const exportBackgroundRemovedCopy = async () => {
    if (!img || !workRef.current) {
      setStatus("Open an image first.");
      return;
    }
    setBusy(true);
    try {
      const name = `${srcInfo?.name || "photo"}-background-removed.png`;
      const sourceCanvas = buildCleanupCanvas({ healArea: false });

      if (bgRemovalAvailable) {
        const resultCanvas = await runBgRemovalEngine(sourceCanvas, null);
        const blob = await canvasToBlob(resultCanvas, "image/png");
        if (!blob) throw new Error("No background removal image blob");
        downloadBlob(blob, name);
        setStatus(`Transparent background copy saved as ${name} using the professional engine (real subject segmentation, works on any background).`);
        return;
      }

      // Browser fallback: flood-fill only works on a near-flat background.
      removeEdgeBackgroundOnCanvas(sourceCanvas, backgroundSensitivity);
      const blob = await canvasToBlob(sourceCanvas, "image/png");
      if (!blob) throw new Error("No background removal image blob");
      downloadBlob(blob, name);
      setStatus(`Transparent background copy saved as ${name} using the browser fallback (works best on a plain, near-flat background - no professional engine detected). If edges remain, increase sensitivity and try again.`);
    } catch (error) {
      console.error(error);
      setStatus("Could not remove the background. Try a simpler image or adjust sensitivity.");
    } finally {
      setBusy(false);
    }
  };

  // Passport / govt photos need a clean solid-white backdrop at an exact
  // size and file-size budget. This removes the existing background, flattens
  // onto white (or the chosen fill), sizes to the preset, and fits the KB cap.
  const exportPassportWhiteBg = async () => {
    if (!img || !workRef.current || !crop.w || !crop.h) {
      setStatus("Open a photo and frame the head and shoulders with the crop box first.");
      return;
    }
    setBusy(true);
    try {
      // 1. Crop at native resolution with the current adjustments baked in.
      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = Math.max(1, Math.round(crop.w));
      cropCanvas.height = Math.max(1, Math.round(crop.h));
      const cctx = cropCanvas.getContext("2d");
      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = "high";
      cctx.filter = filterString;
      cctx.drawImage(workRef.current, crop.x, crop.y, crop.w, crop.h, 0, 0, cropCanvas.width, cropCanvas.height);
      cctx.filter = "none";
      // 2+3. Segment the subject and flatten onto the solid fill (white by
      // default). The professional engine (real segmentation, works on any
      // background) does both in one call; the browser fallback only
      // handles a near-flat background, so it stays a two-step knockout +
      // fill matching its original behavior.
      let fillCanvas;
      let usedEngine = false;
      if (bgRemovalAvailable) {
        try {
          fillCanvas = await runBgRemovalEngine(cropCanvas, bg || "#ffffff");
          usedEngine = true;
        } catch (error) {
          console.warn("Background engine failed, falling back to browser knockout:", error);
        }
      }
      if (!fillCanvas) {
        removeEdgeBackgroundOnCanvas(cropCanvas, backgroundSensitivity);
        fillCanvas = document.createElement("canvas");
        fillCanvas.width = cropCanvas.width;
        fillCanvas.height = cropCanvas.height;
        const fctx = fillCanvas.getContext("2d");
        fctx.fillStyle = bg || "#ffffff";
        fctx.fillRect(0, 0, fillCanvas.width, fillCanvas.height);
        fctx.drawImage(cropCanvas, 0, 0);
      }
      // 4. Scale to the exact output size, sharp.
      const tw = Math.max(1, outW);
      const th = Math.max(1, outH);
      const outCanvas = drawScaled(fillCanvas, 0, 0, fillCanvas.width, fillCanvas.height, tw, th, "none", bg || "#ffffff", true);
      // 5. Encode, honoring a KB target when one is set (JPG/WEBP only).
      const mime = format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
      const extension = format === "png" ? "png" : format === "webp" ? "webp" : "jpg";
      const limit = Number(targetKB) || 0;
      let blob = await canvasToBlob(outCanvas, mime, format === "png" ? undefined : quality);
      if (limit && format !== "png" && blob && blob.size / 1024 > limit) {
        // Same tested search as exportPhoto (./lib/sizeBudgetSearch.js). The
        // white-background canvas is already at its final pixel size, so only
        // the quality search applies here (no dimension shrink fallback).
        const cache = new Map();
        const measure = async (q) => {
          const key = q.toFixed(4);
          if (cache.has(key)) return cache.get(key);
          const candidate = await canvasToBlob(outCanvas, mime, q);
          const size = candidate ? candidate.size / 1024 : Infinity;
          cache.set(key, size);
          if (candidate) cache.set(`blob:${key}`, candidate);
          return size;
        };
        const found = await searchQualityForBudget(measure, tw, th, limit);
        if (found) blob = cache.get(`blob:${found.quality.toFixed(4)}`) || blob;
      }
      if (!blob) throw new Error("No white-background blob");
      const name = `${srcInfo?.name || "photo"}-white-${tw}x${th}.${extension}`;
      downloadBlob(blob, name);
      const kb = Math.max(1, Math.round(blob.size / 1024));
      const engineNote = usedEngine
        ? " (professional engine - real subject segmentation)"
        : " (browser fallback - works best on a plain background; raise Background sensitivity if edges look rough)";
      setStatus(`Saved ${name}: ${tw} x ${th} px on a clean ${bg} background, ${kb} KB${engineNote}.`);
    } catch (error) {
      console.error(error);
      setStatus("Could not build the white-background photo. Try adjusting the crop or sensitivity.");
    } finally {
      setBusy(false);
    }
  };

  const exportWatermarkRemovalCopy = () => {
    if (!authorizedWatermarkRemoval) {
      setStatus("Confirm that you own this image or have permission to remove the watermark first.");
      return;
    }
    return runAreaRepair({
      suffix: "watermark-removed",
      verb: "Watermark removal",
      notOpenMsg: "Open an image and put the crop box tightly around the watermark first.",
      failMsg: "Could not remove that watermark cleanly. Try selecting only the watermark with a tighter crop box.",
    });
  };

  const rememberAiSettings = () => {
    sessionStorage.setItem("photoStudioAiProvider", aiProvider);
    sessionStorage.setItem("photoStudioAiBase", aiBase);
    sessionStorage.setItem("photoStudioAiKey", aiKey);
    sessionStorage.setItem("photoStudioAiModel", aiModel);
    setStatus("Photo AI settings saved for this browser session only.");
  };

  const changeAiProvider = (providerId) => {
    const provider = AI_PROVIDERS[providerId] || AI_PROVIDERS.openai;
    setAiProvider(providerId);
    setAiBase(provider.base);
    setAiModel(provider.model);
  };

  const applyAiSettings = (settings, fallbackText) => {
    // Coercion + honest "did anything actually apply" tracking live in
    // ./lib/aiPhotoSettings.js (tested) - the old version accepted only
    // exact JS types (Number.isFinite/typeof boolean) with no coercion, so a
    // model returning "75" instead of 75 silently applied nothing while the
    // caller still announced success.
    const { values, applied, notes } = parseAiPhotoSettings(settings);
    if ("brightness" in values) setBrightness(values.brightness);
    if ("contrast" in values) setContrast(values.contrast);
    if ("saturation" in values) setSaturation(values.saturation);
    if ("grayscale" in values) setGrayscale(values.grayscale);
    if ("cleanupStrength" in values) setCleanupStrength(values.cleanupStrength);
    setAiAnswer(notes || fallbackText || (applied.length
      ? "AI returned settings and they were applied."
      : "AI answered, but didn't return usable enhancement settings."));
    return applied.length > 0;
  };

  const askPhotoAi = async () => {
    if (!img || !workRef.current || !crop.w || !crop.h) {
      setAiAnswer("Open an image first. The current crop is sent as a small preview for analysis.");
      return;
    }
    if (!aiKey.trim()) {
      setAiAnswer("Paste an API key first. It is stored only in this browser session.");
      return;
    }
    setBusy(true);
    setAiAnswer("Asking AI for enhancement settings...");
    try {
      rememberAiSettings();
      const preview = drawScaled(
        workRef.current,
        crop.x,
        crop.y,
        Math.max(1, crop.w),
        Math.max(1, crop.h),
        Math.min(1024, Math.max(1, Math.round(crop.w))),
        Math.min(1024, Math.max(1, Math.round(crop.h))),
        filterString,
        bg,
        true,
      );
      const dataUrl = canvasToDataUrl(preview, "image/jpeg", 0.86);
      const base64 = dataUrl.split(",")[1];
      const systemPrompt = [
        "You are an image enhancement assistant inside a local photo editor.",
        "Suggest conservative slider settings for clarity and upload quality.",
        "Do not help remove third-party ownership/copyright watermarks.",
        "If the user owns the image or the mark is damage/noise, suggest how to clean it.",
        "Return JSON only with numeric brightness, contrast, saturation, cleanupStrength from 0.2 to 1, boolean grayscale, and short notes.",
      ].join("\n");
      const text = await callAi({
        provider: aiProvider === "claude" ? "anthropic" : aiProvider,
        base: aiBase,
        key: aiKey,
        model: aiModel,
        system: systemPrompt,
        prompt: `User task: ${aiPrompt}`,
        image: base64,
        maxTokens: 700,
      });
      const parsed = extractJsonObject(text);
      if (parsed) {
        const changed = applyAiSettings(parsed, text);
        setStatus(changed
          ? "AI enhancement settings applied. Use Enhanced copy or Cleanup copy to download."
          : "AI answered, but the response didn't include usable enhancement settings.");
      } else {
        setAiAnswer(text || "AI answered, but did not return settings.");
        setStatus("AI answered. No sliders were changed because JSON settings were not found.");
      }
    } catch (error) {
      console.error(error);
      setAiAnswer(`AI request failed: ${error.message}`);
      setStatus("Photo AI request failed.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!img || !workSize.w || !crop.w || !outW || !outH) return undefined;
    const timer = setTimeout(async () => {
      try {
        const blob = await renderBlob(quality, Math.min(outW, 4000), Math.min(outH, 4000));
        setEstimate(blob ? blob.size / 1024 : null);
      } catch {
        setEstimate(null);
      }
    }, 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, workSize, crop, outW, outH, format, quality, brightness, contrast, saturation, grayscale, bg, version]);

  const exportPhoto = async () => {
    if (!img || !crop.w) {
      setStatus("Open a photo and set a crop first.");
      return;
    }
    setBusy(true);
    try {
      const limit = Number(targetKB) || 0;
      let tw = outW;
      let th = outH;
      let usedQuality = quality;
      let blob = await renderBlob(usedQuality, tw, th);
      if (limit && format === "png") {
        setStatus("Target KB needs JPG or WEBP (PNG size cannot be tuned by quality). Downloading PNG at full quality.");
      } else if (limit && blob && blob.size / 1024 > limit) {
        // Tested search in ./lib/sizeBudgetSearch.js: binary-search quality
        // first (keeps the requested pixel size), then shrink dimensions if
        // no quality level can reach the budget.
        const cache = new Map();
        const measure = async (q, w, h) => {
          const key = `${q.toFixed(4)}x${w}x${h}`;
          if (cache.has(key)) return cache.get(key);
          const candidate = await renderBlob(q, w, h);
          const size = candidate ? candidate.size / 1024 : Infinity;
          cache.set(key, size);
          if (candidate && size <= limit) cache.set(`blob:${key}`, candidate);
          return size;
        };
        const found = await fitToSizeBudget(measure, tw, th, limit, { minSide: 40 });
        if (found) {
          const key = `${found.quality.toFixed(4)}x${found.width}x${found.height}`;
          blob = cache.get(`blob:${key}`) || await renderBlob(found.quality, found.width, found.height);
          usedQuality = found.quality;
          tw = found.width;
          th = found.height;
        }
      }
      if (!blob) {
        setStatus("Could not encode the image. Try a different format.");
        return;
      }
      const extension = format === "png" ? "png" : format === "webp" ? "webp" : "jpg";
      const name = `${srcInfo?.name || "photo"}-${tw}x${th}.${extension}`;
      downloadBlob(blob, name);
      const kb = Math.max(1, Math.round(blob.size / 1024));
      const overLimit = limit && kb > limit;
      setStatus(
        `Saved ${name}: ${tw} x ${th} px, ${kb} KB${format !== "png" ? ` (quality ${Math.round(usedQuality * 100)}%)` : ""}.${
          overLimit ? ` Could not reach ${limit} KB - try smaller dimensions.` : limit ? ` Fits the ${limit} KB limit.` : ""
        }`,
      );
    } catch (error) {
      console.error(error);
      setStatus("Export failed. Try a smaller output size.");
    } finally {
      setBusy(false);
    }
  };

  const makePrintSheet = async (paperId) => {
    if (!img || !crop.w) return;
    const paper = PRINT_PAPERS.find((entry) => entry.id === paperId);
    if (!paper) return;
    setBusy(true);
    try {
      const sheetDpi = 300;
      const pageW = Math.round(paper.w * sheetDpi);
      const pageH = Math.round(paper.h * sheetDpi);
      const photoW = Math.max(1, Math.round((outW / dpi) * sheetDpi));
      const photoH = Math.max(1, Math.round((outH / dpi) * sheetDpi));
      const margin = Math.round(0.2 * sheetDpi);
      const gap = Math.round(0.08 * sheetDpi);
      const cols = Math.floor((pageW - margin * 2 + gap) / (photoW + gap));
      const rows = Math.floor((pageH - margin * 2 + gap) / (photoH + gap));
      if (cols < 1 || rows < 1) {
        setStatus(`The photo is too large for a ${paper.label} at 300 DPI. Reduce the output size or DPI.`);
        return;
      }
      const sheet = document.createElement("canvas");
      sheet.width = pageW;
      sheet.height = pageH;
      const ctx = sheet.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, pageW, pageH);
      const cell = drawScaled(workRef.current, crop.x, crop.y, crop.w, crop.h, photoW, photoH, filterString, bg, true);
      ctx.strokeStyle = "#b9c2cc";
      ctx.lineWidth = 1;
      ctx.setLineDash([7, 7]);
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const dx = margin + col * (photoW + gap);
          const dy = margin + row * (photoH + gap);
          ctx.drawImage(cell, dx, dy);
          ctx.strokeRect(dx - 1.5, dy - 1.5, photoW + 3, photoH + 3);
        }
      }
      const blob = await new Promise((resolve) => sheet.toBlob(resolve, "image/jpeg", 0.92));
      downloadBlob(blob, `${srcInfo?.name || "photo"}-print-sheet-${paper.id}.jpg`);
      setStatus(`Print sheet saved: ${cols * rows} copies on ${paper.label} at 300 DPI. Print at 100% scale and cut on the dashed lines.`);
    } catch (error) {
      console.error(error);
      setStatus("Could not build the print sheet.");
    } finally {
      setBusy(false);
    }
  };

  const physicalLabel = outW && outH && dpi
    ? `${((outW / dpi) * 25.4).toFixed(1)} x ${((outH / dpi) * 25.4).toFixed(1)} mm (${(outW / dpi).toFixed(2)} x ${(outH / dpi).toFixed(2)} in) at ${dpi} DPI`
    : "";

  const cropStyle = workSize.w
    ? {
        left: `${(crop.x / workSize.w) * 100}%`,
        top: `${(crop.y / workSize.h) * 100}%`,
        width: `${(crop.w / workSize.w) * 100}%`,
        height: `${(crop.h / workSize.h) * 100}%`,
      }
    : null;

  return (
    <main
      className="app-shell photo-shell"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        openFile(event.dataTransfer.files?.[0]);
      }}
    >
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Crop size={18} /></div>
          <div>
            <strong>Photo Studio</strong>
            <span>{srcInfo ? `${srcInfo.name} - ${srcInfo.w} x ${srcInfo.h} px` : "Crop, resize, passport & upload-limit exports"}</span>
          </div>
        </div>
        <div className="top-actions">
          <button onClick={onBack} className="ghost"><ArrowLeft size={17} />PDF Studio</button>
          <button onClick={() => fileRef.current?.click()} className="ghost"><Upload size={17} />Open image</button>
          <button onClick={exportPhoto} disabled={!img || busy} className="primary"><Download size={17} />Download</button>
          <input
            ref={fileRef}
            className="file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/bmp,image/gif"
            onChange={(event) => {
              openFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
      </header>

      <aside className="page-rail photo-presets">
        <div className="rail-title">Presets</div>
        {PHOTO_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className={`preset-chip ${presetId === preset.id ? "active" : ""}`}
            onClick={() => selectPreset(preset.id)}
          >
            <strong>{preset.label}</strong>
            <span>{preset.hint}</span>
          </button>
        ))}
      </aside>

      <section className="workspace">
        <nav className="toolstrip">
          <button onClick={() => setRotation((value) => (value + 90) % 360)} disabled={!img} title="Rotate 90 degrees" aria-label="Rotate"><RotateCw size={18} /></button>
          <button onClick={() => setFlipH((value) => !value)} disabled={!img} className={flipH ? "active" : ""} title="Flip horizontal" aria-label="Flip horizontal"><FlipHorizontal2 size={18} /></button>
          <button onClick={() => setFlipV((value) => !value)} disabled={!img} className={flipV ? "active" : ""} title="Flip vertical" aria-label="Flip vertical"><FlipVertical2 size={18} /></button>
          <span className="tool-divider" />
          <button className="quick-action" onClick={() => setCrop(centeredCrop(workSize.w, workSize.h, aspect))} disabled={!img}>
            <Crop size={16} />Center crop
          </button>
          <button className="quick-action" onClick={() => { setLockRatio(false); setAspect(null); setCrop({ x: 0, y: 0, w: workSize.w, h: workSize.h }); }} disabled={!img}>
            <Maximize2 size={16} />Whole image
          </button>
          <button className="quick-action" onClick={useCropAsOutput} disabled={!img}>
            <Ruler size={16} />Crop = output px
          </button>
          <button className="quick-action" onClick={() => { setBrightness(100); setContrast(100); setSaturation(100); setGrayscale(false); }} disabled={!img}>
            <Contrast size={16} />Reset adjust
          </button>
        </nav>

        <div className="page-stage photo-stage">
          {!img ? (
            <>
            <div className="sticky-note"><span>Paste with Ctrl / &#8984; V.</span></div>
            <button className="dropzone" onClick={() => fileRef.current?.click()}>
              <ImagePlus size={38} />
              <strong>Open a photo, any size</strong>
              <span>
                Crop it, resize to exact pixels or mm, hit government upload limits (10-50 KB), make passport photos,
                and build 300 DPI print sheets. You can also paste an image from the clipboard.
              </span>
            </button>
            </>
          ) : (
            <div className="photo-canvas-wrap" ref={wrapRef} onPointerDown={beginDrag("new")}>
              <canvas ref={previewRef} className="photo-canvas" style={{ filter: filterString }} />
              {cropStyle && (
                <div className="crop-box" style={cropStyle} onPointerDown={beginDrag("move")}>
                  <div className="crop-grid" />
                  {["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((corner) => (
                    <i key={corner} className={`crop-handle ${corner}`} onPointerDown={beginDrag("resize", corner)} />
                  ))}
                  <span className="crop-size">{Math.round(crop.w)} x {Math.round(crop.h)} px</span>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <aside className="inspector">
        <div className="panel">
          <div className="panel-title"><ImagePlus size={16} />Source</div>
          <p className="status">{busy ? "Working..." : status}</p>
          {srcInfo && (
            <p className="fine-print">
              Original: {srcInfo.w} x {srcInfo.h} px, {srcInfo.sizeKB} KB. Everything runs in your browser - the photo never leaves this device.
            </p>
          )}
        </div>

        <div className="panel">
          <div className="panel-title"><Ruler size={16} />Output size</div>
          <div className="dim-row">
            <label className="field">
              Width px
              <input type="number" min="1" max="20000" value={outW} onChange={(event) => setOutDimension("w", event.target.value)} />
            </label>
            <label className="field">
              Height px
              <input type="number" min="1" max="20000" value={outH} onChange={(event) => setOutDimension("h", event.target.value)} />
            </label>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={lockRatio} onChange={toggleLockRatio} />
            Lock crop box to this ratio (no stretching)
          </label>
          <label className="field">
            DPI (for print / mm sizes)
            <select value={dpi} onChange={(event) => setDpi(Number(event.target.value))}>
              {[72, 96, 150, 200, 300, 600].map((value) => (
                <option key={value} value={value}>{value} DPI</option>
              ))}
            </select>
          </label>
          {physicalLabel && <p className="fine-print">Prints at {physicalLabel}.</p>}
        </div>

        <div className="panel">
          <div className="panel-title"><Download size={16} />Format & file size</div>
          <div className="segmented" aria-label="Image format">
            {[["jpeg", "JPG"], ["png", "PNG"], ["webp", "WEBP"]].map(([id, label]) => (
              <button key={id} className={format === id ? "active" : ""} onClick={() => setFormat(id)}>{label}</button>
            ))}
          </div>
          <label className="field">
            Quality {Math.round(quality * 100)}%
            <input type="range" min="0.3" max="1" step="0.01" value={quality} onChange={(event) => setQuality(Number(event.target.value))} disabled={format === "png"} />
          </label>
          <label className="field">
            Target file size KB (for upload limits)
            <input type="number" min="0" placeholder="e.g. 50" value={targetKB} onChange={(event) => setTargetKB(event.target.value)} />
          </label>
          <label className="field">
            Background fill (JPG has no transparency)
            <input type="color" value={bg} onChange={(event) => setBg(event.target.value)} className="color-input" />
          </label>
          <p className="fine-print">
            {estimate != null
              ? `Estimated download: ~${Math.max(1, Math.round(estimate))} KB at current settings.`
              : "The size estimate appears here once a photo is loaded."}
          </p>
        </div>

        <div className="panel">
          <div className="panel-title"><Contrast size={16} />Adjust</div>
          <label className="field">
            Brightness {brightness}%
            <input type="range" min="40" max="180" value={brightness} onChange={(event) => setBrightness(Number(event.target.value))} />
          </label>
          <label className="field">
            Contrast {contrast}%
            <input type="range" min="40" max="180" value={contrast} onChange={(event) => setContrast(Number(event.target.value))} />
          </label>
          <label className="field">
            Saturation {saturation}%
            <input type="range" min="0" max="200" value={saturation} onChange={(event) => setSaturation(Number(event.target.value))} />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={grayscale} onChange={(event) => setGrayscale(event.target.checked)} />
            Grayscale (clean signature / document scans)
          </label>
        </div>

        <div className="panel">
          <div className="panel-title"><Eraser size={16} />Background & object remover</div>
          <p className="fine-print">
            Background removal exports a transparent PNG. Object removal uses the crop box as the object selection and exports a repaired copy.
          </p>
          <label className="field">
            Background sensitivity {Math.round(backgroundSensitivity * 100)}%
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.02"
              value={backgroundSensitivity}
              onChange={(event) => setBackgroundSensitivity(Number(event.target.value))}
            />
          </label>
          <div className="button-grid two">
            <button onClick={exportBackgroundRemovedCopy} disabled={!img || busy}>
              <Eraser size={16} />Remove background
            </button>
            <button onClick={exportObjectRemovalCopy} disabled={!img || busy}>
              <Brush size={16} />Remove selected object
            </button>
          </div>
          <button className="secondary-action" onClick={exportPassportWhiteBg} disabled={!img || busy}>
            <ImagePlus size={16} />Passport photo on clean white background
          </button>
          <p className="fine-print">
            White-background export removes the backdrop, flattens onto the fill color above, and sizes to your preset and KB limit - ideal for passport, visa, and govt uploads. For object removal, select only the unwanted object with the crop box.
          </p>
        </div>

        <div className="panel">
          <div className="panel-title"><Wand2 size={16} />Watermark removal</div>
          <p className="fine-print">
            Place the crop box tightly around the watermark or stamped mark, then create a separate repaired download.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={authorizedWatermarkRemoval}
              onChange={(event) => setAuthorizedWatermarkRemoval(event.target.checked)}
            />
            I own this image or have permission to remove the watermark
          </label>
          <button className="secondary-action" onClick={exportWatermarkRemovalCopy} disabled={!img || busy || !authorizedWatermarkRemoval}>
            <Wand2 size={16} />Remove selected watermark
          </button>
          <p className="fine-print">For best results, select only the watermark area, not the full photo.</p>
        </div>

        <div className="panel">
          <div className="panel-title"><Brush size={16} />Cleanup repair</div>
          <p className="fine-print">
            Put the crop box tightly around damage or a mark in your own/authorized image, then download a repaired copy. The old crop/export workflow is not changed.
          </p>
          <label className="field">
            Repair strength {Math.round(cleanupStrength * 100)}%
            <input
              type="range"
              min="0.2"
              max="1"
              step="0.02"
              value={cleanupStrength}
              onChange={(event) => setCleanupStrength(Number(event.target.value))}
            />
          </label>
          <div className="button-grid two">
            <button onClick={exportCleanupCopy} disabled={!img || busy}>
              <Wand2 size={16} />Cleanup copy
            </button>
            <button onClick={exportEnhancedCopy} disabled={!img || busy}>
              <Sparkles size={16} />Enhanced copy
            </button>
          </div>
          <p className="fine-print">Best for stains, scan marks, scratches, or watermarks you are legally allowed to remove.</p>
        </div>

        <div className="panel">
          <div className="panel-title"><Sparkles size={16} />AI enhance</div>
          <label className="field">
            Provider
            <select value={aiProvider} onChange={(event) => changeAiProvider(event.target.value)}>
              {Object.entries(AI_PROVIDERS).map(([id, provider]) => (
                <option key={id} value={id}>{provider.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            API base URL
            <input value={aiBase} onChange={(event) => setAiBase(event.target.value)} />
          </label>
          <label className="field">
            API key
            <input value={aiKey} onChange={(event) => setAiKey(event.target.value)} placeholder="Stored for this session only" type="password" />
          </label>
          <label className="field">
            Model
            <input value={aiModel} onChange={(event) => setAiModel(event.target.value)} />
          </label>
          <label className="field">
            Enhancement request
            <textarea className="ai-prompt" value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} />
          </label>
          <div className="button-grid two">
            <button onClick={rememberAiSettings}>Save session</button>
            <button onClick={askPhotoAi} disabled={!img || busy}>Ask AI</button>
          </div>
          {aiAnswer && <pre className="ai-answer">{aiAnswer}</pre>}
          <p className="fine-print">AI reads a small preview of the current crop and applies suggested local sliders. Your key stays in browser session storage.</p>
        </div>

        <div className="panel">
          <div className="panel-title"><Printer size={16} />Print sheet (300 DPI)</div>
          <div className="button-grid two">
            {PRINT_PAPERS.map((paper) => (
              <button key={paper.id} onClick={() => makePrintSheet(paper.id)} disabled={!img || busy}>
                <Printer size={16} />{paper.label}
              </button>
            ))}
          </div>
          <p className="fine-print">Tiles the cropped photo across the sheet with cut lines - print at 100% scale.</p>
        </div>
      </aside>
    </main>
  );
}

export default PhotoStudio;
