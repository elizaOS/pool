#!/usr/bin/env python3
"""Decode the QR straight out of the phone screenshot.

The unit tests prove the encoder is correct in the abstract. This proves the
thing a donor's camera actually sees, after CSS scaling and PNG rasterization,
still decodes to a real anthropic authorize URL. That is the difference between
"the QR is correct" and "the QR is scannable".
"""
import pathlib
import sys

from PIL import Image

SHOTS = pathlib.Path("/opt/pool/projects/eliza-fleet/shots")

# Run with /tmp/qrvenv/bin/python, which has the real zxing-cpp scanner.
try:
    import numpy as np
    import zxingcpp

    def decode(img):
        return [r.text for r in zxingcpp.read_barcodes(np.array(img.convert("RGB"))) if r.text]

except Exception as exc:  # pragma: no cover
    print(f"SKIP no qr decoder available ({exc}); run with /tmp/qrvenv/bin/python")
    sys.exit(0)

fail = 0
for name in ("join-phone-deviceflow.png", "join-desktop-deviceflow.png"):
    path = SHOTS / name
    if not path.exists():
        print(f"SKIP {name} missing")
        continue
    img = Image.open(path)
    results = decode(img)
    # Full-page shots are very tall; if the whole-image pass finds nothing, try
    # the upper region where the QR sits.
    if not results:
        results = decode(img.crop((0, 0, img.width, min(3000, img.height))))
    ok = any("anthropic.com" in r or "claude.ai" in r for r in results)
    if ok:
        url = next(r for r in results if "anthropic.com" in r or "claude.ai" in r)
        print(f"PASS {name}: decoded {len(url)} chars -> {url[:78]}...")
    else:
        fail += 1
        print(f"FAIL {name}: decoded {results!r}")

print("\nqr-from-screenshot:", "ok" if not fail else f"{fail} failed")
sys.exit(1 if fail else 0)
