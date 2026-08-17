#!/usr/bin/env python3
"""Screenshot /join at phone and desktop widths, including the live device-flow
state (the screen a donor actually stares at while scanning the QR).

The phone view is the product here, so it is captured mid-flow, not just the
landing page: if the QR or the code box is broken at 390px the demo is dead.
"""
import json
import pathlib
import sys
import urllib.request

from playwright.sync_api import sync_playwright

OUT = pathlib.Path("/opt/pool/projects/eliza-fleet/shots")
OUT.mkdir(parents=True, exist_ok=True)

KEYS = json.loads(pathlib.Path("/opt/pool/secrets/pool-keys.json").read_text())
ADMIN = next(k["key"] for k in KEYS["keys"] if k.get("admin"))
BASE = "http://127.0.0.1:18811"


def mint(note):
    req = urllib.request.Request(
        f"{BASE}/admin/invite",
        data=json.dumps({"tier": "donor", "note": note, "ttlHours": 2}).encode(),
        headers={"x-api-key": ADMIN, "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["url"].split("?i=")[1]


def cancel(session_id):
    req = urllib.request.Request(
        f"{BASE}/join/cancel",
        data=json.dumps({"sessionId": session_id}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=20).read()
    except Exception as exc:  # cancelling is cleanup, never fatal to the shot
        print(f"  (cancel failed: {exc})")


shots = []

with sync_playwright() as p:
    # The pinned playwright build (1200) is not installed; 1208 and the system
    # chromium are. Use whichever exists rather than pulling a browser down.
    launch = {}
    for cand in (
        "~/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome",
        "~/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell",
        "/usr/bin/chromium-browser",
    ):
        if pathlib.Path(cand).exists():
            launch["executable_path"] = cand
            print(f"using browser: {cand}")
            break
    browser = p.chromium.launch(**launch)

    for name, width, height, mobile in [
        ("desktop", 1280, 900, False),
        ("phone", 390, 844, True),
    ]:
        ctx = browser.new_context(
            viewport={"width": width, "height": height},
            device_scale_factor=2,
            is_mobile=mobile,
            has_touch=mobile,
        )
        page = ctx.new_page()

        # 1. landing
        tok = mint(f"shot-{name}")
        page.goto(f"{BASE}/join?i={tok}", wait_until="networkidle", timeout=60000)
        f = OUT / f"join-{name}-landing.png"
        page.screenshot(path=str(f), full_page=True)
        shots.append(f)
        print(f"shot {f.name}")

        # 2. the device-flow screen (real broker flow, cancelled right after)
        sid = None
        try:
            page.click("#go")
            page.wait_for_selector(".qrwrap svg", timeout=150000)
            page.wait_for_timeout(700)
            sid = page.evaluate(
                "()=>{const m=document.body.innerHTML.match(/sessionId=([A-Za-z0-9-]+)/);return m?m[1]:null}"
            )
            f = OUT / f"join-{name}-deviceflow.png"
            page.screenshot(path=str(f), full_page=True)
            shots.append(f)
            print(f"shot {f.name}")

            # QR must be big enough to scan off a laptop screen at arm's length
            box = page.locator(".qrwrap svg").first.bounding_box()
            print(f"  QR rendered {box['width']:.0f}x{box['height']:.0f} css px")
            if box["width"] < 150:
                print(f"  WARN qr small for {name}")

            # nothing may overflow the viewport horizontally on mobile
            ow = page.evaluate(
                "()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)"
            )
            iw = page.evaluate("()=>window.innerWidth")
            print(f"  scrollWidth={ow} innerWidth={iw} {'OK' if ow <= iw + 1 else 'OVERFLOW'}")
        except Exception as exc:
            print(f"  device-flow shot failed for {name}: {exc}")
        finally:
            if sid:
                cancel(sid)

        # 3. the rules / honesty block, framed on its own
        page.goto(f"{BASE}/join?i={mint(f'shot2-{name}')}", wait_until="networkidle", timeout=60000)
        try:
            page.locator(".card.warn").scroll_into_view_if_needed()
            page.wait_for_timeout(250)
            f = OUT / f"join-{name}-rules.png"
            page.screenshot(path=str(f))
            shots.append(f)
            print(f"shot {f.name}")
        except Exception as exc:
            print(f"  rules shot failed: {exc}")

        # 4. status + ledger
        for route in ("status", "ledger"):
            page.goto(f"{BASE}/{route}", wait_until="networkidle", timeout=60000)
            f = OUT / f"{route}-{name}.png"
            page.screenshot(path=str(f), full_page=True)
            shots.append(f)
            print(f"shot {f.name}")

        ctx.close()

    browser.close()

print(f"\n{len(shots)} screenshots -> {OUT}")
for s in shots:
    print(f"  {s.name}  {s.stat().st_size // 1024}kb")
