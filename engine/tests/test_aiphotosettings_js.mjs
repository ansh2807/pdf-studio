// Unit tests for src/lib/aiPhotoSettings.js - parsing Photo Studio's "ask AI"
// response into slider values, honestly tracking what actually applied.
//   node engine/tests/test_aiphotosettings_js.mjs
import { parseAiPhotoSettings, clampNum } from "../../src/lib/aiPhotoSettings.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  cond ? pass++ : fail++;
}
const J = (x) => JSON.stringify(x);

// ---------- well-formed response (numbers as numbers) ----------
{
  const r = parseAiPhotoSettings({ brightness: 110, contrast: 95, saturation: 120, grayscale: false, cleanupStrength: 0.6, notes: "brightened" });
  ok("all fields parsed", r.applied.length === 5, J(r));
  ok("values match", r.values.brightness === 110 && r.values.contrast === 95, J(r.values));
  ok("notes captured", r.notes === "brightened");
}

// ---------- THE BUG THIS FIXES: numbers returned as strings ----------
{
  const r = parseAiPhotoSettings({ brightness: "110", contrast: "95.5", cleanupStrength: "0.7" });
  ok("string numbers are coerced", r.applied.includes("brightness") && r.applied.includes("contrast"), J(r));
  ok("string number values are correct", r.values.brightness === 110 && r.values.contrast === 96 /* rounded */, J(r.values));
}
{
  const r = parseAiPhotoSettings({ grayscale: "true" });
  ok("string boolean 'true' coerced", r.values.grayscale === true, J(r));
}
{
  const r = parseAiPhotoSettings({ grayscale: "false" });
  ok("string boolean 'false' coerced", r.values.grayscale === false, J(r));
}

// ---------- THE OTHER HALF OF THE BUG: nothing usable must report honestly ----------
{
  const r = parseAiPhotoSettings({});
  ok("empty object applies nothing", r.applied.length === 0, J(r));
}
{
  const r = parseAiPhotoSettings({ foo: "bar", summary: "looks good" });
  ok("unrelated JSON applies nothing", r.applied.length === 0, J(r));
}
{
  const r = parseAiPhotoSettings({ brightness: "not a number", grayscale: "maybe" });
  ok("garbage values are rejected, not silently zeroed", r.applied.length === 0, J(r));
}
{
  const r = parseAiPhotoSettings(null);
  ok("null input doesn't throw and applies nothing", r.applied.length === 0, J(r));
}

// ---------- clamping ----------
{
  const r = parseAiPhotoSettings({ brightness: 999, saturation: -50, cleanupStrength: 5 });
  ok("out-of-range values clamp to bounds",
     r.values.brightness === 180 && r.values.saturation === 0 && r.values.cleanupStrength === 1, J(r.values));
}
{
  const r = parseAiPhotoSettings({ brightness: 42.7 });
  ok("brightness rounds to integer", r.values.brightness === 43, J(r.values));
}

// ---------- partial success is reported partially, not all-or-nothing ----------
{
  const r = parseAiPhotoSettings({ brightness: 100, saturation: "oops" });
  ok("partial success: brightness applied, saturation skipped",
     r.applied.includes("brightness") && !r.applied.includes("saturation"), J(r));
}

ok("clampNum basic", clampNum(5, 0, 10) === 5 && clampNum(-1, 0, 10) === 0 && clampNum(99, 0, 10) === 10);

console.log(`\nAI-PHOTO-SETTINGS (JS): ${pass}/${pass + fail} passed`);
console.log("RESULT:", fail === 0 ? "PASS" : "FAIL");
process.exit(fail === 0 ? 0 : 1);
