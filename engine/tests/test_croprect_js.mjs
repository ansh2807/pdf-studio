// Unit tests for src/lib/cropRect.js - Photo Studio's crop/resize/preset math.
// The key regression: an aspect-locked rect must NEVER end up wider or taller
// than the source image, which the original clampRect allowed.
//   node engine/tests/test_croprect_js.mjs
import { centeredCrop, clampRect, clampNum } from "../../src/lib/cropRect.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  cond ? pass++ : fail++;
}
const within = (rect, W, H) =>
  rect.x >= -1e-6 && rect.y >= -1e-6 && rect.x + rect.w <= W + 1e-6 && rect.y + rect.h <= H + 1e-6
  && rect.w > 0 && rect.h > 0 && Number.isFinite(rect.x) && Number.isFinite(rect.y);

// ---------- centeredCrop ----------
{
  const r = centeredCrop(1000, 800, 1); // square in a landscape image
  ok("centeredCrop square fits", within(r, 1000, 800) && Math.abs(r.w - r.h) < 1e-6, JSON.stringify(r));
  const full = centeredCrop(1000, 800, null);
  ok("centeredCrop no-aspect returns full image",
     full.x === 0 && full.y === 0 && full.w === 1000 && full.h === 800);
}

// ---------- clampRect: the regression this file targets ----------
{
  // THE BUG: a wide aspect (2.0) with h near the image's full height (H=800)
  // used to inflate w to h*aspect=1600, blowing past W=1000, and the position
  // clamp (min>max) pushed x NEGATIVE instead of correcting it.
  const W = 1000, H = 800, aspect = 2.0;
  const rect = clampRect({ x: 0, y: 0, w: 1000, h: 800 }, W, H, aspect);
  ok("wide-aspect near-full-height rect stays within bounds", within(rect, W, H), JSON.stringify(rect));
  ok("wide-aspect rect keeps the aspect ratio",
     Math.abs(rect.w / rect.h - aspect) < 1e-6, `${rect.w}/${rect.h}=${rect.w / rect.h}`);
}
{
  // Mirror case: a very tall aspect (0.2) with w near the image's full width.
  const W = 1000, H = 800, aspect = 0.2;
  const rect = clampRect({ x: 0, y: 0, w: 1000, h: 800 }, W, H, aspect);
  ok("tall-aspect near-full-width rect stays within bounds", within(rect, W, H), JSON.stringify(rect));
  ok("tall-aspect rect keeps the aspect ratio",
     Math.abs(rect.w / rect.h - aspect) < 1e-6, `${rect.w}/${rect.h}=${rect.w / rect.h}`);
}
{
  // Passport-style extreme aspect (35:45 -> 0.777..) against a small square image.
  const W = 400, H = 400, aspect = 35 / 45;
  const rect = clampRect({ x: 50, y: 50, w: 400, h: 400 }, W, H, aspect);
  ok("passport aspect on square image stays within bounds", within(rect, W, H), JSON.stringify(rect));
}
{
  // Free crop (no aspect) still clamps position/size normally.
  const rect = clampRect({ x: -50, y: 900, w: 200, h: 200 }, 1000, 800, null);
  ok("free crop clamps position into bounds", within(rect, 1000, 800), JSON.stringify(rect));
}
{
  // Minimum-size floor (8px) still respected after aspect correction.
  const rect = clampRect({ x: 0, y: 0, w: 3, h: 3 }, 1000, 800, 1);
  ok("tiny rect floors to minimum size", rect.w >= 8 && rect.h >= 8, JSON.stringify(rect));
}

// ---------- fuzz: many random aspects/sizes must always stay in bounds ----------
{
  let allOk = true;
  let worst = null;
  const rand = (seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)(42);
  for (let i = 0; i < 500; i += 1) {
    const W = 50 + rand() * 2000;
    const H = 50 + rand() * 2000;
    const aspect = 0.1 + rand() * 5;
    const rect = clampRect(
      { x: rand() * W, y: rand() * H, w: rand() * W * 1.5, h: rand() * H * 1.5 }, W, H, aspect);
    if (!within(rect, W, H)) { allOk = false; worst = { W, H, aspect, rect }; break; }
  }
  ok("fuzz: 500 random aspect/size combos all stay in bounds", allOk, worst ? JSON.stringify(worst) : "");
}

ok("clampNum basic", clampNum(5, 0, 10) === 5 && clampNum(-1, 0, 10) === 0 && clampNum(99, 0, 10) === 10);
ok("clampNum inverted range returns min (defensive)", clampNum(5, 10, -5) === 10);

console.log(`\nCROP-RECT (JS): ${pass}/${pass + fail} passed`);
console.log("RESULT:", fail === 0 ? "PASS" : "FAIL");
process.exit(fail === 0 ? 0 : 1);
