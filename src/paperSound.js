/*
  paperSound.js - a tiny synthesized paper-sound engine for Paper Studio.

  Ported from the Claude Design "Paper Studio" prototype. Everything is
  generated live with the Web Audio API (filtered noise + a low thump), so
  there are no audio files to ship and nothing ever hits the network.

  It's a module-level singleton because the crumple/flip sounds are triggered
  from a few different places (the intro, the view switch) and there should
  only ever be one AudioContext. Audio only starts after a user gesture, per
  browser autoplay rules; call resumeOnGesture() from a global pointerdown.
*/

let ac = null;
let master = null;
let noiseBuffer = null;
let enabled = true;

function context() {
  if (ac) return ac;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ac = new AC();
  master = ac.createGain();
  master.gain.value = 0.32;
  master.connect(ac.destination);
  return ac;
}

function getNoiseBuffer() {
  if (noiseBuffer) return noiseBuffer;
  const len = Math.floor(ac.sampleRate * 1.5);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buf;
  return noiseBuffer;
}

function paperNoise(t0, dur, opts = {}) {
  const src = ac.createBufferSource();
  src.buffer = getNoiseBuffer();
  src.loop = true;
  src.playbackRate.value = 0.9 + Math.random() * 0.2;

  const filter = ac.createBiquadFilter();
  filter.type = opts.type || "bandpass";
  filter.Q.value = opts.q || 1.2;
  filter.frequency.setValueAtTime(opts.from || 2800, t0);
  if (opts.to) filter.frequency.exponentialRampToValueAtTime(opts.to, t0 + dur);

  const gain = ac.createGain();
  const peak = opts.peak || 0.5;
  gain.gain.setValueAtTime(0.0001, t0);
  if (opts.crackle) {
    const n = Math.max(3, Math.floor(dur * (opts.density || 18)));
    for (let i = 0; i < n; i += 1) {
      const t = t0 + (i / n) * dur + Math.random() * (dur / n) * 0.8;
      const v = peak * (0.25 + Math.random() * 0.75);
      gain.gain.setValueAtTime(v, t);
      gain.gain.exponentialRampToValueAtTime(0.015, Math.min(t0 + dur, t + 0.03 + Math.random() * 0.05));
    }
  } else {
    gain.gain.linearRampToValueAtTime(peak, t0 + (opts.attack || dur * 0.3));
  }
  gain.gain.linearRampToValueAtTime(0.0001, t0 + dur);

  const env = ac.createGain();
  env.gain.setValueAtTime(1, t0);
  if (opts.fadeOut) {
    env.gain.setValueAtTime(1, t0 + dur * 0.55);
    env.gain.linearRampToValueAtTime(0.0001, t0 + dur);
  }

  src.connect(filter);
  filter.connect(gain);
  gain.connect(env);
  env.connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

function thump(t0) {
  const osc = ac.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(110, t0);
  osc.frequency.exponentialRampToValueAtTime(55, t0 + 0.12);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.5, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
  osc.connect(gain);
  gain.connect(master);
  osc.start(t0);
  osc.stop(t0 + 0.16);
}

function withContext(fn) {
  if (!enabled) return;
  const ctx = context();
  if (!ctx) return;
  if (ctx.state === "running") {
    try { fn(); } catch { /* audio graph errors are non-fatal */ }
  } else {
    ctx.resume().then(() => {
      try { fn(); } catch { /* ignore */ }
    }).catch(() => {});
  }
}

/** The crumple-toss-unfold sequence played with the intro animation. */
export function playIntro() {
  withContext(() => {
    const t = ac.currentTime + 0.03;
    paperNoise(t, 1.05, { from: 500, to: 2200, q: 0.8, peak: 0.35, attack: 0.55 });
    thump(t + 1.1);
    paperNoise(t + 1.06, 0.22, { from: 2000, q: 1, peak: 0.6, crackle: true, density: 40 });
    paperNoise(t + 1.2, 1.0, { from: 3200, q: 1.6, peak: 0.5, crackle: true, density: 22, fadeOut: true });
  });
}

/** A short page-flip crackle, used when switching studios or unmuting. */
export function playFlip() {
  withContext(() => {
    const t = ac.currentTime + 0.01;
    paperNoise(t, 0.32, { from: 2600, to: 3800, q: 1.4, peak: 0.42, crackle: true, density: 34, fadeOut: true });
  });
}

export function setEnabled(value) {
  enabled = Boolean(value);
  if (enabled) {
    const ctx = context();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  }
}

export function isEnabled() {
  return enabled;
}

/** Wire to a global pointerdown so a suspended context resumes on first gesture. */
export function resumeOnGesture() {
  if (ac && ac.state === "suspended") ac.resume().catch(() => {});
}
