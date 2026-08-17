"""Decode QR matrices produced by lib/qr.js using zxing-cpp (a real scanner).

Reads {"cases":[{"name":..,"text":..,"rows":["0101..",..]}]} on stdin and prints
one PASS/FAIL line per case plus a trailing summary. Each matrix is rendered to
a scaled bitmap with a quiet zone, exactly like a phone camera would see it.
"""
import json
import sys

import numpy as np
import zxingcpp
from PIL import Image

payload = json.load(sys.stdin)
SCALE = 8
QUIET = 4

failures = 0
for case in payload["cases"]:
    rows = case["rows"]
    n = len(rows)
    grid = np.ones((n + QUIET * 2, n + QUIET * 2), dtype=np.uint8) * 255
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == "1":
                grid[y + QUIET, x + QUIET] = 0
    img = Image.fromarray(grid, mode="L").resize(
        ((n + QUIET * 2) * SCALE, (n + QUIET * 2) * SCALE), Image.NEAREST
    )
    results = zxingcpp.read_barcodes(img)
    got = results[0].text if results else None
    fmt = str(results[0].format) if results else "none"
    if got == case["text"]:
        print(f"PASS {case['name']}: decoded {len(got)} chars via {fmt}")
    else:
        failures += 1
        print(f"FAIL {case['name']}: expected {case['text'][:60]!r} got {str(got)[:60]!r}")

print(f"\n{len(payload['cases']) - failures} passed, {failures} failed")
sys.exit(1 if failures else 0)
