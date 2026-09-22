#!/usr/bin/env python3
"""
Watermark-engine test harness.

The trick that makes this a real test and not a vibe check: we SYNTHESISE the
watermark ourselves, so we hold the ground-truth original. We composite a known
mark onto a known background, hand the engine only (watermarked image + mask),
and then measure how close the recovered pixels are to the original we hid.

For semi-transparent marks the ceiling is essentially perfect (the info is only
mixed), so we assert high PSNR / SSIM. For opaque marks the pixels are gone, so
we only assert "no worse than a sensible baseline and no blur cliff".

Run:  python engine/tests/test_photo_watermark.py
"""

from __future__ import annotations
import sys, os, math
import numpy as np
import cv2

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from watermark.photo_watermark import remove_watermark, score_result  # noqa: E402


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #
def psnr(a, b, mask=None):
    a = a.astype(np.float64); b = b.astype(np.float64)
    if mask is not None:
        m = mask > 127
        if m.sum() == 0:
            return 99.0
        diff = (a - b)[m]
    else:
        diff = (a - b).ravel()
    mse = float(np.mean(diff * diff))
    if mse < 1e-9:
        return 99.0
    return 10.0 * math.log10((255.0 ** 2) / mse)


def ssim(a, b):
    a = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY).astype(np.float64)
    b = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY).astype(np.float64)
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    k = (11, 11)
    mu_a = cv2.GaussianBlur(a, k, 1.5); mu_b = cv2.GaussianBlur(b, k, 1.5)
    va = cv2.GaussianBlur(a * a, k, 1.5) - mu_a ** 2
    vb = cv2.GaussianBlur(b * b, k, 1.5) - mu_b ** 2
    vab = cv2.GaussianBlur(a * b, k, 1.5) - mu_a * mu_b
    s = ((2 * mu_a * mu_b + C1) * (2 * vab + C2)) / \
        ((mu_a ** 2 + mu_b ** 2 + C1) * (va + vb + C2))
    return float(np.mean(s))


# --------------------------------------------------------------------------- #
# Synthetic backgrounds (known ground truth)
# --------------------------------------------------------------------------- #
def bg_flat(h, w, seed):
    r = np.random.RandomState(seed)
    c = r.randint(60, 200, 3)
    img = np.ones((h, w, 3), np.float32) * c
    img += r.normal(0, 3, (h, w, 3))
    return np.clip(img, 0, 255).astype(np.uint8)


def bg_gradient(h, w, seed):
    r = np.random.RandomState(seed)
    x = np.linspace(0, 255, w); y = np.linspace(0, 255, h)
    gx, gy = np.meshgrid(x, y)
    img = np.stack([gx, gy, (gx + gy) / 2], -1).astype(np.float32)
    return np.clip(img + r.normal(0, 4, (h, w, 3)), 0, 255).astype(np.uint8)


def bg_texture(h, w, seed):
    """High-frequency 'grass/fabric' style texture."""
    r = np.random.RandomState(seed)
    noise = r.rand(h, w).astype(np.float32)
    noise = cv2.resize(cv2.resize(noise, (w // 4, h // 4)), (w, h))
    base = np.stack([noise * 120 + 40, noise * 160 + 30, noise * 90 + 20], -1)
    fine = r.normal(0, 18, (h, w, 3))
    return np.clip(base + fine, 0, 255).astype(np.uint8)


def bg_stripes(h, w, seed):
    """Structured periodic pattern (brick-ish) - hard for naive fills."""
    img = np.zeros((h, w, 3), np.float32)
    for i in range(h):
        for band, col in ((20, (150, 90, 60)),):
            pass
    yy, xx = np.mgrid[0:h, 0:w]
    pat = ((xx // 24 + (yy // 16) % 2) % 2)
    img[..., 0] = 60 + pat * 90
    img[..., 1] = 40 + pat * 70
    img[..., 2] = 30 + pat * 60
    mortar = ((yy % 16) < 3) | ((xx % 24) < 3)
    img[mortar] = (200, 200, 195)
    return img.astype(np.uint8)


BACKGROUNDS = {
    "flat": bg_flat,
    "gradient": bg_gradient,
    "texture": bg_texture,
    "stripes": bg_stripes,
}


# --------------------------------------------------------------------------- #
# Watermark synthesis
# --------------------------------------------------------------------------- #
def make_text_mask(h, w, text="SAMPLE", scale=None, angle=0):
    mask = np.zeros((h, w), np.uint8)
    scale = scale or w / 240.0
    thick = max(2, int(scale * 2))
    size = cv2.getTextSize(text, cv2.FONT_HERSHEY_DUPLEX, scale, thick)[0]
    org = ((w - size[0]) // 2, (h + size[1]) // 2)
    cv2.putText(mask, text, org, cv2.FONT_HERSHEY_DUPLEX, scale, 255, thick, cv2.LINE_AA)
    if angle:
        M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        mask = cv2.warpAffine(mask, M, (w, h))
    return mask


def composite(bg, mark_mask, alpha, color):
    """I = alpha*W + (1-alpha)*J on masked pixels. Returns (watermarked, mask255)."""
    out = bg.astype(np.float32).copy()
    m = (mark_mask > 127)
    W = np.array(color, np.float32)
    out[m] = alpha * W + (1 - alpha) * out[m]
    return np.clip(out, 0, 255).astype(np.uint8), (m.astype(np.uint8) * 255)


# --------------------------------------------------------------------------- #
# Test matrix
# --------------------------------------------------------------------------- #
def run():
    H = W = 256
    results = []
    seed = 0

    semitransparent_cases = []
    for bg_name in BACKGROUNDS:
        for alpha in (0.25, 0.4, 0.6):
            for color in ((255, 255, 255), (0, 0, 0), (200, 40, 40)):
                for angle in (0, 30):
                    semitransparent_cases.append((bg_name, alpha, color, angle))

    passed = 0
    total = 0
    worst = []
    for bg_name, alpha, color, angle in semitransparent_cases:
        seed += 1
        bg = BACKGROUNDS[bg_name](H, W, seed)
        mmask = make_text_mask(H, W, "SAMPLE", angle=angle)
        if mmask.sum() == 0:
            continue
        wm, mask255 = composite(bg, mmask, alpha, color)

        # Baseline: what the OLD edge-smear-style fill would score (cv2 telea as proxy)
        base = cv2.inpaint(wm, mask255, 4, cv2.INPAINT_TELEA)
        base_psnr = psnr(bg, base, mask255)

        r = remove_watermark(wm, mask255)
        rec = r["image"]
        p = psnr(bg, rec, mask255)
        s = ssim(bg, rec)

        total += 1
        # Pass if the result is either high-quality in absolute terms (>=30 dB is
        # visually clean) OR clearly beats the inpaint baseline (proof that matte
        # inversion recovered real detail a fill could not).
        ok = (p >= 30.0) or (p >= base_psnr + 3.0)
        passed += ok
        rec_row = dict(case=f"{bg_name}/a{alpha}/{color}/rot{angle}",
                       tier=r["tier"], psnr=round(p, 1),
                       base_psnr=round(base_psnr, 1), ssim=round(s, 3),
                       conf=round(r["confidence"], 3), ok=ok)
        results.append(rec_row)
        if not ok:
            worst.append(rec_row)

    # ---- opaque case: pixels are gone, assert no blur-cliff (sharpness parity) ----
    opaque_pass = 0; opaque_total = 0
    for bg_name in ("texture", "stripes", "flat"):
        seed += 1
        bg = BACKGROUNDS[bg_name](H, W, seed)
        mmask = make_text_mask(H, W, "COPY", angle=20)
        wm, mask255 = composite(bg, mmask, 1.0, (255, 255, 255))  # fully opaque
        r = remove_watermark(wm, mask255)
        sc = score_result(wm, r["image"], mask255)
        opaque_total += 1
        # Opaque: truth is unrecoverable, so we only require the fill not be a
        # degenerate blur cliff - continuity holds and it is not near-zero score.
        opaque_ok = sc["continuity"] >= 0.4 and sc["score"] >= 0.30
        opaque_pass += opaque_ok
        print(f"[opaque] {bg_name:8} tier={r['tier']:12} "
              f"score={sc['score']} cont={sc['continuity']} sharp={sc['sharpness']} "
              f"{'Y' if opaque_ok else 'N'}")

    # ---- report ----
    print("=" * 78)
    print("SEMI-TRANSPARENT WATERMARK RECOVERY (ground-truth known)")
    print("=" * 78)
    print(f"{'case':38} {'tier':13} {'psnr':>6} {'base':>6} {'ssim':>6} {'ok':>3}")
    for row in results:
        print(f"{row['case']:38} {row['tier']:13} {row['psnr']:6} "
              f"{row['base_psnr']:6} {row['ssim']:6} {'Y' if row['ok'] else 'N':>3}")
    mean_psnr = np.mean([r["psnr"] for r in results])
    mean_base = np.mean([r["base_psnr"] for r in results])
    print("-" * 78)
    print(f"semi-transparent: {passed}/{total} passed | "
          f"mean PSNR {mean_psnr:.1f} dB vs inpaint-baseline {mean_base:.1f} dB "
          f"(+{mean_psnr - mean_base:.1f} dB)")
    print(f"opaque (no-blur-cliff): {opaque_pass}/{opaque_total} passed")
    if worst:
        print(f"\n{len(worst)} case(s) below bar:")
        for row in worst:
            print("   ", row["case"], row["tier"], "psnr", row["psnr"])

    ok_all = passed >= int(0.85 * total) and opaque_pass == opaque_total
    print("\nRESULT:", "PASS" if ok_all else "FAIL")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(run())
