#!/usr/bin/env python3
"""
Background removal engine (production).

Replaces the old `removeEdgeBackgroundOnCanvas` flood-fill (PhotoStudio.jsx),
which only works when the background is a near-uniform flat colour - it
flood-fills from the image border by colour proximity, so any real photo
background (a room, outdoors, a patterned backdrop) defeats it entirely.

This uses U2Net (a real saliency-segmentation network) via ONNX to predict a
genuine per-pixel foreground/background probability mask, then composites the
subject onto transparency or a solid colour - the same job Remove.bg-style
tools do, running locally.

Preprocessing/postprocessing here is a direct, careful port of rembg's own
u2net session code (https://github.com/danielgatis/rembg,
rembg/sessions/u2net.py + base.py) - the maintainers of the exact model file
this engine loads - rather than a guessed pipeline. The bundled model is
verified against rembg's published checksum
(md5 60024c5c889badc19c04ad937298a77b) so the file itself is confirmed
correct before any of this code runs.

Optional dependency: requires `onnxruntime` and engine/models/u2net.onnx.
Both are already required for the LaMa watermark tier if that's installed;
this reuses the same runtime. Degrades to `None` (caller falls back to the
browser's flood-fill) if either is missing.
"""

from __future__ import annotations

import os
import numpy as np
import cv2

_U2NET_INPUT_SIZE = 320
_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
_STD = np.array([0.229, 0.224, 0.225], np.float32)

_session = None
_load_attempted = False


def _model_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "u2net.onnx")


def bg_removal_available() -> bool:
    try:
        import onnxruntime  # noqa: F401
    except Exception:
        return False
    return os.path.isfile(_model_path())


def _get_session():
    global _session, _load_attempted
    if _session is not None or _load_attempted:
        return _session
    _load_attempted = True
    try:
        import onnxruntime as ort
        path = _model_path()
        if not os.path.isfile(path):
            return None
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        _session = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
    except Exception:
        _session = None
    return _session


def predict_mask(img_bgr: np.ndarray) -> np.ndarray | None:
    """Returns an HxW float32 mask in [0,1] (1 = foreground/subject), at the
    ORIGINAL image resolution. None if the model/runtime isn't available.

    Faithful port of rembg's U2netSession.predict + BaseSession.normalize:
    resize to 320x320 (LANCZOS), scale to [0,1] by the image's own max (not a
    flat /255 - matches the reference exactly), per-channel ImageNet-style
    normalize, run the model, take output[0] channel 0, min-max stretch to
    [0,1], then resize the mask back up to the source resolution (LANCZOS).
    """
    session = _get_session()
    if session is None:
        return None

    H, W = img_bgr.shape[:2]
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(rgb, (_U2NET_INPUT_SIZE, _U2NET_INPUT_SIZE), interpolation=cv2.INTER_LANCZOS4)

    arr = resized.astype(np.float32)
    arr = arr / max(float(arr.max()), 1e-6)
    normed = (arr - _MEAN) / _STD
    chw = np.transpose(normed, (2, 0, 1))[None].astype(np.float32)

    try:
        outputs = session.run(None, {session.get_inputs()[0].name: chw})
    except Exception:
        return None

    pred = outputs[0][:, 0, :, :]  # first (main) output, single channel
    mi, ma = float(pred.min()), float(pred.max())
    pred = (pred - mi) / max(ma - mi, 1e-6)
    pred = np.squeeze(pred).astype(np.float32)

    mask_full = cv2.resize(pred, (W, H), interpolation=cv2.INTER_LANCZOS4)
    return np.clip(mask_full, 0, 1)


def remove_background(img_bgr: np.ndarray, bg_color: tuple[int, int, int] | None = None,
                      threshold: float | None = None) -> dict:
    """Returns {"image": np.uint8 array, "mode": "rgba"|"bgr", "coverage": float}.

    If bg_color is given (B, G, R), composites the subject onto that flat
    colour (BGR uint8 output) - for passport/ID-photo style exports. If not,
    returns an RGBA image with a real alpha channel (transparent background)
    for general "remove background" use.

    `threshold`, if given, hard-thresholds the mask (0/1) instead of using it
    as a soft alpha - useful when a clean hard edge is wanted over a soft
    matte; default None keeps the soft matte (better for hair/fine edges).
    """
    mask = predict_mask(img_bgr)
    if mask is None:
        return {"image": None, "mode": None, "coverage": 0.0}

    alpha = (mask >= threshold).astype(np.float32) if threshold is not None else mask
    coverage = float(np.mean(alpha > 0.5))

    if bg_color is not None:
        bg = np.array(bg_color, np.float32).reshape(1, 1, 3)
        out = img_bgr.astype(np.float32) * alpha[..., None] + bg * (1 - alpha[..., None])
        return {"image": np.clip(out, 0, 255).astype(np.uint8), "mode": "bgr", "coverage": coverage}

    rgba = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2BGRA)
    rgba[..., 3] = np.clip(alpha * 255, 0, 255).astype(np.uint8)
    return {"image": rgba, "mode": "rgba", "coverage": coverage}


if __name__ == "__main__":
    import argparse
    import json as _json
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--bg-color", default=None, help="hex RRGGBB to composite onto (else transparent PNG)")
    ap.add_argument("--threshold", type=float, default=None)
    a = ap.parse_args()

    img = cv2.imread(a.input, cv2.IMREAD_COLOR)
    if img is None:
        print(_json.dumps({"ok": False, "error": f"could not read image: {a.input}"}))
        raise SystemExit(1)

    bg = None
    if a.bg_color:
        hexs = a.bg_color.lstrip("#")
        r, g, b = int(hexs[0:2], 16), int(hexs[2:4], 16), int(hexs[4:6], 16)
        bg = (b, g, r)

    r = remove_background(img, bg_color=bg, threshold=a.threshold)
    if r["image"] is None:
        print(_json.dumps({"ok": False, "error": "background removal model/runtime not available"}))
        raise SystemExit(1)

    ok = cv2.imwrite(a.output, r["image"])
    if not ok:
        print(_json.dumps({"ok": False, "error": f"could not write output: {a.output}"}))
        raise SystemExit(1)
    print(_json.dumps({"ok": True, "engine": "u2net", "mode": r["mode"], "coverage": round(r["coverage"], 4)}))
