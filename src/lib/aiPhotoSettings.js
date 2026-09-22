// Parses the AI enhancement response (Photo Studio's "ask AI" feature) into
// clamped slider values, tracking which fields ACTUALLY applied.
//
// The bug this fixes: the old code checked `Number.isFinite(next.brightness)`
// and `typeof next.grayscale === "boolean"` with no coercion, then always
// told the user "AI enhancement settings applied" whenever the response
// parsed as JSON AT ALL - regardless of whether any field matched. Some
// models (and imperfect prompts) return numbers as strings ("75" instead of
// 75) or omit fields entirely; the user was told it worked while nothing
// changed. This coerces sane string representations and reports exactly
// which keys applied, so the caller can tell the truth.

export function clampNum(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

const RANGES = {
  brightness: [40, 180],
  contrast: [40, 180],
  saturation: [0, 200],
  cleanupStrength: [0.2, 1],
};

function coerceNumber(value) {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  return Number.isFinite(n) ? n : null;
}

function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return null;
}

/**
 * @param {object} raw - parsed JSON from the AI response (may be malformed).
 * @returns {{ values: object, applied: string[] }} `values` has only the
 *   keys that successfully parsed, already clamped/rounded; `applied` lists
 *   which of them changed something. An empty `applied` means the response
 *   was valid JSON but contained nothing usable - the caller should say so
 *   honestly rather than claim success.
 */
export function parseAiPhotoSettings(raw) {
  const next = raw || {};
  const values = {};
  const applied = [];

  for (const key of ["brightness", "contrast", "saturation", "cleanupStrength"]) {
    const n = coerceNumber(next[key]);
    if (n === null) continue;
    const [lo, hi] = RANGES[key];
    values[key] = key === "cleanupStrength" ? clampNum(n, lo, hi) : Math.round(clampNum(n, lo, hi));
    applied.push(key);
  }

  const gs = coerceBoolean(next.grayscale);
  if (gs !== null) {
    values.grayscale = gs;
    applied.push("grayscale");
  }

  const notes = next.notes || next.cleanupAdvice || null;
  return { values, applied, notes };
}
