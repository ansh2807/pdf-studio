#!/usr/bin/env python3
"""
LaMa deep-inpainting tier test.

Validates the ONNX preprocessing against the MODEL AUTHOR'S OWN reference
example (Carve/LaMa-ONNX: image.jpg + mask.png + output_onnx_fp32.png,
downloaded once into engine/tests/proof/). This is ground truth from the
people who built the model, not a self-consistency check.

Also locks in the real bug found while integrating this: skipping mask
dilation before feeding the model leaves a visible "ghost" of the original
content at the mask boundary (measured 22.7dB vs 39.8dB against the
reference with dilation - a large, easy-to-miss quality regression that
would otherwise sit invisible in code review).

Skips (not fails) if the model file or onnxruntime isn't present, or the
reference fixtures haven't been downloaded - this tier is optional-dependency
by design (see module docstring in photo_watermark.py).

Run:  python engine/tests/test_lama_inpaint.py
"""
from __future__ import annotations
import os, sys, math
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, ROOT)

REF_IMAGE = os.path.join(HERE, "proof", "ref_image.jpg")
REF_MASK = os.path.join(HERE, "proof", "ref_mask.png")
REF_EXPECTED = os.path.join(HERE, "proof", "ref_output_expected.png")
MODEL_PATH = os.path.join(ROOT, "models", "lama_fp32.onnx")


def psnr(a, b):
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return 99.0 if mse < 1e-9 else 10.0 * math.log10((255.0 ** 2) / mse)


def main():
    from watermark.photo_watermark import lama_available, _get_lama_session, _lama_infer

    if not os.path.isfile(MODEL_PATH):
        print(f"SKIP: model not found at {MODEL_PATH} (optional dependency)")
        return 0
    if not lama_available():
        print("SKIP: onnxruntime not installed (optional dependency)")
        return 0
    missing = [p for p in (REF_IMAGE, REF_MASK, REF_EXPECTED) if not os.path.isfile(p)]
    if missing:
        print(f"SKIP: reference fixtures not downloaded: {missing}")
        print("  (see engine/tests/proof/ - fetch from https://huggingface.co/Carve/LaMa-ONNX)")
        return 0

    session = _get_lama_session()
    if session is None:
        print("SKIP: LaMa session failed to load")
        return 0

    img = cv2.imread(REF_IMAGE)
    mask = cv2.imread(REF_MASK, cv2.IMREAD_GRAYSCALE)
    expected = cv2.imread(REF_EXPECTED)

    img_512 = cv2.resize(img, (512, 512), interpolation=cv2.INTER_AREA)
    mask_512 = cv2.resize(mask, (512, 512), interpolation=cv2.INTER_NEAREST)
    mask_bin = (mask_512 > 127).astype(np.uint8) * 255

    results = []

    # THE REGRESSION GUARD: no dilation must score noticeably worse than with.
    out_no_dilate = _lama_infer(img_512, mask_bin, session)
    p_no_dilate = psnr(out_no_dilate, expected)
    results.append(("no-dilation (regression guard)", p_no_dilate, p_no_dilate < 30.0))

    kernel = np.ones((5, 5), np.uint8)
    mask_dilated = cv2.dilate(mask_bin, kernel, iterations=1)
    out_dilated = _lama_infer(img_512, mask_dilated, session)
    p_dilated = psnr(out_dilated, expected)
    results.append(("with dilation (correct pipeline)", p_dilated, p_dilated >= 35.0))

    cv2.imwrite(os.path.join(HERE, "proof", "lama_regression_no_dilate.png"), out_no_dilate)
    cv2.imwrite(os.path.join(HERE, "proof", "lama_regression_dilated.png"), out_dilated)

    ok = True
    for name, val, cond in results:
        print(f"  {'PASS' if cond else 'FAIL'}  {name}: {val:.2f}dB")
        ok = ok and cond

    ok = ok and (p_dilated > p_no_dilate + 5.0)
    print(f"  {'PASS' if p_dilated > p_no_dilate + 5.0 else 'FAIL'}  "
          f"dilation measurably improves quality: +{p_dilated - p_no_dilate:.1f}dB")

    # ---- full patch-based pipeline (remove_by_lama) on a synthetic case ----
    from watermark.photo_watermark import remove_by_lama, score_result
    H = W = 900  # bigger than the 512 model input, exercises the patch-crop path
    rng = np.random.RandomState(9)
    noise = cv2.resize(cv2.resize(rng.rand(H, W).astype(np.float32), (W // 5, H // 5)), (W, H))
    bg = np.stack([noise * 140 + 40, noise * 100 + 60, noise * 80 + 30], -1).astype(np.uint8)
    wmask = np.zeros((H, W), np.uint8)
    cv2.putText(wmask, "OPAQUE", (250, 480), cv2.FONT_HERSHEY_DUPLEX, 3.2, 255, 6, cv2.LINE_AA)
    opaque = bg.copy()
    opaque[wmask > 0] = (255, 255, 255)  # fully opaque mark - pixels genuinely gone

    result = remove_by_lama(opaque, wmask)
    patch_ok = result is not None and result.shape == opaque.shape
    print(f"  {'PASS' if patch_ok else 'FAIL'}  patch-based pipeline (900x900, >512 input) runs and returns correct shape")
    ok = ok and patch_ok

    if patch_ok:
        # Everything far from the mask must be untouched. Near the mask
        # boundary a few pixels are DELIBERATELY feathered (blended) to avoid
        # a hard seam - that band is excluded here by eroding the "far"
        # region in from the mask complement rather than testing every pixel.
        far_from_mask = cv2.erode((wmask == 0).astype(np.uint8), np.ones((15, 15), np.uint8)) > 0
        # A Gaussian blur's tail never reaches exactly zero, so allow a tiny
        # tolerance rather than exact equality - anything beyond a few pixels
        # of drift this far from the mask would be a real leak, not blur math.
        far_diff = np.abs(result[far_from_mask].astype(int) - opaque[far_from_mask].astype(int))
        outside_identical = far_diff.max() <= 4
        print(f"  {'PASS' if outside_identical else 'FAIL'}  pixels far from the mask stay within blur-tail tolerance "
              f"(max diff {far_diff.max()}/255, {int((far_diff.sum(axis=-1) > 0).sum())} px touched)")
        ok = ok and outside_identical
        # Pixels entirely OUTSIDE the crop patch must be byte-identical - no
        # feathering should ever reach past the patch that was cropped/composited.
        outside_patch = np.ones((H, W), bool)
        # (patch bounds aren't exposed by remove_by_lama - approximate via a
        # generous margin around the mask bbox, which the patch cannot exceed
        # given context_ratio; anything further out is provably untouched.)
        ys, xs = np.where(wmask > 0)
        margin = int(max(ys.max() - ys.min(), xs.max() - xs.min()) * 2)
        y0, y1 = max(0, ys.min() - margin), min(H, ys.max() + margin)
        x0, x1 = max(0, xs.min() - margin), min(W, xs.max() + margin)
        outside_patch[y0:y1, x0:x1] = False
        far_identical = np.array_equal(result[outside_patch], opaque[outside_patch])
        print(f"  {'PASS' if far_identical else 'FAIL'}  pixels well outside the crop patch are byte-identical")
        ok = ok and far_identical

        sc = score_result(opaque, result, wmask)
        quality_ok = sc["score"] > 0.4
        print(f"  {'PASS' if quality_ok else 'FAIL'}  reconstructed region scores reasonably: {sc}")
        ok = ok and quality_ok
        cv2.imwrite(os.path.join(HERE, "proof", "lama_patch_pipeline_result.png"), result)

    print(f"\nLAMA-INPAINT: {'PASS' if ok else 'FAIL'}")
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
