#!/usr/bin/env python3
"""
Background removal (U2Net) engine test.

Validates against the real reference photo (same one used for LaMa
validation - a legitimate photographic test case already in the repo):
mask shape/range, transparent-PNG alpha correctness, solid-color composite
math, and that the model is genuinely detected via its checksummed file.

Skips (not fails) if the model/runtime isn't present - optional dependency
by design, same as the LaMa tier.

Run:  python engine/tests/test_bg_removal.py
"""
from __future__ import annotations
import os, sys, hashlib
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, ROOT)

REF_IMAGE = os.path.join(HERE, "proof", "ref_image.jpg")
MODEL_PATH = os.path.join(ROOT, "models", "u2net.onnx")
EXPECTED_MD5 = "60024c5c889badc19c04ad937298a77b"


def main():
    from background.remove_bg import bg_removal_available, predict_mask, remove_background

    if not os.path.isfile(MODEL_PATH):
        print(f"SKIP: model not found at {MODEL_PATH} (optional dependency)")
        return 0
    if not bg_removal_available():
        print("SKIP: onnxruntime not installed (optional dependency)")
        return 0
    if not os.path.isfile(REF_IMAGE):
        print(f"SKIP: reference photo not found at {REF_IMAGE}")
        return 0

    results = []

    def chk(name, cond, detail=""):
        results.append((name, cond))
        print(f"  {'PASS' if cond else 'FAIL'}  {name}  {detail}")

    md5 = hashlib.md5(open(MODEL_PATH, "rb").read()).hexdigest()
    chk("model file matches rembg's published checksum (confirms correct file)",
        md5 == EXPECTED_MD5, md5)

    img = cv2.imread(REF_IMAGE)
    mask = predict_mask(img)
    chk("mask shape matches input", mask is not None and mask.shape == img.shape[:2], mask.shape if mask is not None else None)
    chk("mask values in [0,1]", mask is not None and 0.0 <= mask.min() and mask.max() <= 1.0,
        (float(mask.min()), float(mask.max())) if mask is not None else None)
    chk("mask is not degenerate (some real variation, not flat)",
        mask is not None and mask.std() > 0.05, float(mask.std()) if mask is not None else None)

    # ---- transparent output: alpha channel must equal the mask ----
    r_transparent = remove_background(img)
    ok_shape = r_transparent["image"] is not None and r_transparent["image"].shape == (img.shape[0], img.shape[1], 4)
    chk("transparent output is RGBA with correct shape", ok_shape, r_transparent["image"].shape if ok_shape else None)
    if ok_shape:
        alpha = r_transparent["image"][..., 3].astype(np.float32) / 255.0
        alpha_matches_mask = float(np.abs(alpha - mask).max()) < 0.01
        chk("alpha channel matches the predicted mask", alpha_matches_mask, float(np.abs(alpha - mask).max()))
        chk("coverage is plausible (neither ~0% nor ~100% of frame)",
            0.02 < r_transparent["coverage"] < 0.85, r_transparent["coverage"])

    # ---- solid-color composite: background pixels must equal the target color ----
    white = (255, 255, 255)
    r_white = remove_background(img, bg_color=white)
    ok_shape2 = r_white["image"] is not None and r_white["image"].shape == img.shape
    chk("solid-bg output is BGR with correct shape", ok_shape2)
    if ok_shape2:
        # Pixels the mask is CONFIDENT are background should be close to white.
        bg_confident = mask < 0.05
        if bg_confident.sum() > 100:
            bg_pixels = r_white["image"][bg_confident]
            close_to_white = np.abs(bg_pixels.astype(int) - np.array(white)[::-1]).max(axis=1)
            frac_close = float(np.mean(close_to_white < 10))
            chk("confident-background pixels composite close to the target color",
                frac_close > 0.9, f"{frac_close:.2%} within tolerance")
        # Pixels the mask is CONFIDENT are foreground should be close to original.
        fg_confident = mask > 0.95
        if fg_confident.sum() > 100:
            orig_fg = img[fg_confident].astype(int)
            new_fg = r_white["image"][fg_confident].astype(int)
            diff = np.abs(orig_fg - new_fg).max(axis=1)
            frac_unchanged = float(np.mean(diff < 10))
            chk("confident-foreground pixels are preserved (not altered)",
                frac_unchanged > 0.9, f"{frac_unchanged:.2%} within tolerance")

    # ---- degenerate input: solid color image (nothing salient) shouldn't crash ----
    flat = np.full((200, 200, 3), 128, np.uint8)
    r_flat = remove_background(flat)
    chk("flat/featureless image doesn't crash", r_flat["image"] is not None)

    passed = sum(1 for _, ok in results if ok)
    total = len(results)
    print(f"\nBG-REMOVAL: {passed}/{total} passed")
    print("RESULT:", "PASS" if passed == total else "FAIL")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
