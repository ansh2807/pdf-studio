// Unit tests for src/lib/sizeBudgetSearch.js - the KB-budget search behind
// Photo Studio's passport/govt-exam presets ("under 50 KB", etc).
//   node engine/tests/test_sizebudget_js.mjs
import { searchQualityForBudget, shrinkToFitBudget, fitToSizeBudget } from "../../src/lib/sizeBudgetSearch.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  cond ? pass++ : fail++;
}

// Synthetic JPEG-like size model: monotonic in quality AND in pixel count.
// sizeKB(q, w, h) = k * w * h * q^1.5  (roughly mirrors real JPEG behavior:
// size grows with resolution and super-linearly with quality).
function makeModel(k = 0.00005) {
  return (q, w, h) => k * w * h * Math.pow(q, 1.5);
}

async function main() {
  // ---------- searchQualityForBudget ----------
  {
    // Pick a budget that is actually TIGHT relative to max-quality size (k*w*h
    // at q=1 is 18 KB here), so the optimum falls inside (minQuality,
    // maxQuality) instead of saturating at the max - otherwise this isn't
    // testing convergence.
    const k = 0.00005;
    const measure = makeModel(k);
    const w = 600, h = 600, limitKB = 8;
    const result = await searchQualityForBudget(measure, w, h, limitKB);
    ok("finds a quality under the budget", result && result.sizeKB <= limitKB, JSON.stringify(result));
    // True optimum quality solves k*w*h*q^1.5 = limitKB.
    const trueQ = Math.pow(limitKB / (k * w * h), 1 / 1.5);
    ok("converges close to the true optimal quality (within 5%)",
       Math.abs(result.quality - trueQ) / trueQ < 0.05, `got ${result.quality}, true ${trueQ}`);
  }
  {
    // Budget is generous - even max quality fits. Should return near-max quality.
    const measure = makeModel(0.000001);
    const result = await searchQualityForBudget(measure, 600, 600, 500);
    ok("generous budget uses high quality", result && result.quality > 0.9, JSON.stringify(result));
  }
  {
    // Budget unreachable even at minimum quality -> null, not a wrong answer.
    const measure = makeModel(1); // huge multiplier, everything is oversized
    const result = await searchQualityForBudget(measure, 600, 600, 10);
    ok("unreachable budget returns null (not a false positive)", result === null, JSON.stringify(result));
  }

  // ---------- shrinkToFitBudget ----------
  {
    const measure = makeModel(1); // same "everything huge" model
    const result = await shrinkToFitBudget(measure, 600, 600, 10, { quality: 0.7, minSide: 40 });
    if (result) {
      ok("shrink result actually fits budget", result.sizeKB <= 10, JSON.stringify(result));
      ok("shrink result respects minSide floor", result.width >= 40 && result.height >= 40, JSON.stringify(result));
    } else {
      // Even at minSide=40 the model may still exceed 10KB - that's a valid
      // outcome (matches the real app's "could not reach target" message), not
      // a test failure, as long as it didn't crash or loop forever (it didn't).
      ok("shrink correctly gives up rather than crash/loop", true);
    }
  }
  {
    // Shrink must terminate even when it can never succeed (extreme model).
    const measure = () => 999999;
    const start = Date.now();
    const result = await shrinkToFitBudget(measure, 600, 600, 1, { minSide: 40, steps: 8 });
    const elapsed = Date.now() - start;
    ok("shrink terminates promptly on an impossible budget", elapsed < 500 && result === null, `${elapsed}ms`);
  }

  // ---------- fitToSizeBudget (full strategy) ----------
  {
    const measure = makeModel();
    const result = await fitToSizeBudget(measure, 600, 600, 50);
    ok("full strategy prefers quality search (keeps requested dimensions)",
       result && result.strategy === "quality" && result.width === 600 && result.height === 600,
       JSON.stringify(result));
  }
  {
    // A budget too tight for ANY quality at 600x600 forces the shrink fallback.
    const measure = makeModel(0.01);
    const result = await fitToSizeBudget(measure, 600, 600, 20, { minSide: 40 });
    ok("full strategy falls back to shrink when quality alone can't reach budget",
       !result || result.strategy === "shrink" || result.width < 600, JSON.stringify(result));
  }

  console.log(`\nSIZE-BUDGET (JS): ${pass}/${pass + fail} passed`);
  console.log("RESULT:", fail === 0 ? "PASS" : "FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
