// Unit tests for engine/rateLimiter.cjs - the AI-proxy abuse guard.
// Uses a fake clock (no real waiting) so the whole suite runs instantly.
//   node engine/tests/test_ratelimiter_js.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { RateLimiter } = require("../rateLimiter.cjs");

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  cond ? pass++ : fail++;
}

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (sec) => { t += sec * 1000; } };
}

// ---------- basic capacity ----------
{
  const clock = fakeClock();
  const rl = new RateLimiter({ capacity: 3, refillPerSec: 1, now: clock.now });
  const results = [rl.take("ip1"), rl.take("ip1"), rl.take("ip1"), rl.take("ip1")];
  ok("first N=capacity requests allowed",
     results.slice(0, 3).every((r) => r.allowed), JSON.stringify(results.slice(0, 3)));
  ok("request beyond capacity rejected", results[3].allowed === false, JSON.stringify(results[3]));
  ok("rejection includes a sane retryAfterSec", results[3].retryAfterSec > 0 && results[3].retryAfterSec < 10);
}

// ---------- refill over time ----------
{
  const clock = fakeClock();
  const rl = new RateLimiter({ capacity: 2, refillPerSec: 1, now: clock.now });
  rl.take("ip2"); rl.take("ip2");
  ok("exhausted after 2 takes", rl.take("ip2").allowed === false);
  clock.advance(1); // 1 token refills
  ok("one token refilled after 1s", rl.take("ip2").allowed === true);
  ok("still exhausted immediately after", rl.take("ip2").allowed === false);
  clock.advance(10); // fully refills, capped at capacity (not unbounded)
  const afterLongWait = rl.take("ip2");
  ok("refill caps at capacity, doesn't overflow",
     afterLongWait.allowed === true && afterLongWait.remaining <= 2, JSON.stringify(afterLongWait));
}

// ---------- independent per-key buckets ----------
{
  const clock = fakeClock();
  const rl = new RateLimiter({ capacity: 1, refillPerSec: 0.01, now: clock.now });
  ok("ip A gets its own token", rl.take("A").allowed === true);
  ok("ip A exhausted", rl.take("A").allowed === false);
  ok("ip B is unaffected by ip A's usage", rl.take("B").allowed === true);
}

// ---------- sweep / memory bound ----------
{
  const clock = fakeClock();
  const rl = new RateLimiter({ capacity: 5, refillPerSec: 1, now: clock.now });
  for (let i = 0; i < 50; i += 1) rl.take(`ip-${i}`);
  ok("50 distinct IPs create 50 buckets", rl.size() === 50, rl.size());
  clock.advance(7200); // 2 hours idle
  rl.sweep(3600);
  ok("sweep clears buckets idle past maxAge", rl.size() === 0, rl.size());
}

// ---------- realistic AI-proxy scenario ----------
{
  // Cap 10, refill 10/min matches the intended production config: the one
  // legitimate caller (occasional AI-enhance clicks) never notices; a script
  // hammering the endpoint gets throttled fast.
  const clock = fakeClock();
  const rl = new RateLimiter({ capacity: 10, refillPerSec: 10 / 60, now: clock.now });
  let allowedCount = 0;
  for (let i = 0; i < 15; i += 1) if (rl.take("attacker").allowed) allowedCount += 1;
  ok("burst of 15 rapid requests capped near capacity (10)",
     allowedCount === 10, `allowed=${allowedCount}`);
}

console.log(`\nRATE-LIMITER (JS): ${pass}/${pass + fail} passed`);
console.log("RESULT:", fail === 0 ? "PASS" : "FAIL");
process.exit(fail === 0 ? 0 : 1);
