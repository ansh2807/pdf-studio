// Quality/size search for hitting a strict KB budget (passport photos, govt
// exam uploads: "under 50 KB", "20-50 KB", etc.) - Photo Studio's flagship
// export-to-budget feature. Extracted so the search algorithm can be verified
// against a synthetic size model instead of only ever being eyeballed against
// real JPEG encodes.
//
// `measureSize(quality, w, h)` returns the encoded size in KB for a candidate;
// callers pass a function wrapping canvas.toBlob in the browser, or a fake
// monotonic model in tests.

// Binary search over JPEG quality in [minQuality, maxQuality] for the highest
// quality whose encoded size is still <= limitKB, at fixed w x h. Assumes
// measureSize is monotonically non-decreasing in quality (true for JPEG/WEBP).
// Returns { quality, sizeKB } for the best candidate found, or null if even
// minQuality exceeds the limit.
// `measureSize` may return a number OR a Promise<number> - `await` resolves
// either, so the same function serves a synchronous test model and a real
// async canvas.toBlob encoder without duplicating the search logic.
export async function searchQualityForBudget(measureSize, w, h, limitKB, {
  minQuality = 0.05, maxQuality = 0.95, rounds = 8,
} = {}) {
  let lo = minQuality;
  let hi = maxQuality;
  let best = null;
  for (let round = 0; round < rounds; round += 1) {
    const mid = (lo + hi) / 2;
    const sizeKB = await measureSize(mid, w, h);
    if (sizeKB <= limitKB) {
      best = { quality: mid, sizeKB };
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

// Fallback when no quality at the requested dimensions fits: shrink w/h by
// `shrinkFactor` each step (at a fixed quality) until under the limit, floored
// at minSide. Returns { width, height, sizeKB } or null if still over budget
// after `steps` shrinks.
export async function shrinkToFitBudget(measureSize, w, h, limitKB, {
  quality = 0.7, shrinkFactor = 0.85, minSide = 40, steps = 8,
} = {}) {
  let tw = w;
  let th = h;
  for (let step = 0; step < steps; step += 1) {
    tw = Math.max(minSide, Math.round(tw * shrinkFactor));
    th = Math.max(minSide, Math.round(th * shrinkFactor));
    const sizeKB = await measureSize(quality, tw, th);
    if (sizeKB <= limitKB) return { width: tw, height: th, sizeKB };
    if (tw === minSide && th === minSide) break; // can't shrink further
  }
  return null;
}

// Full strategy: try quality search first (keeps requested dimensions, usually
// preferred for ID-photo specs), then fall back to shrinking dimensions.
export async function fitToSizeBudget(measureSize, w, h, limitKB, opts = {}) {
  const byQuality = await searchQualityForBudget(measureSize, w, h, limitKB, opts);
  if (byQuality) return { width: w, height: h, ...byQuality, strategy: "quality" };
  const byShrink = await shrinkToFitBudget(measureSize, w, h, limitKB, opts);
  if (byShrink) return { ...byShrink, quality: opts.quality ?? 0.7, strategy: "shrink" };
  return null;
}
