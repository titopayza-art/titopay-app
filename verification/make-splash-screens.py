#!/usr/bin/env python3
"""Generate the iOS startup images the PWA declares.

WHY THIS EXISTS. iOS shows a white rectangle between the moment someone taps
the home-screen icon and the app's first paint, unless an apple-touch-startup-
image whose pixel size matches the device EXACTLY is supplied. That white flash
is the single most website-feeling moment an installed app has.

The app shipped one such image, for one device, and that file was truncated:
only the top 660 rows of 2532 were ever written, so it had no IEND chunk and
would not decode. Every device, including the one it was cut for, got the flash
the file existed to prevent.

The images are drawn to match what the app paints on its own first frame -- the
same vertical gradient as `body`, the same wordmark at the same relative width
-- so the handover from the system splash to the app is invisible.

    python3 verification/make-splash-screens.py

Needs Pillow. Run it again only when the launch screen's colours or the
wordmark change; the output is committed, not built at deploy time.
"""

import os
import sys

try:
    from PIL import Image
except ImportError:  # pragma: no cover - tooling, not shipped code
    sys.exit("Pillow is required: pip install Pillow")

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "..", "pwa", "assets")
LOGO = os.path.join(ASSETS, "titopay-logo.png")

# The stops of the `body` gradient in styles.css, so the system splash and the
# app's own first frame are the same picture.
STOPS = [(0.0, (243, 247, 254)), (0.4, (250, 252, 255)), (1.0, (238, 244, 254))]

# Portrait only: the manifest pins the app to portrait. Each entry is the
# device's CSS size and its pixel ratio, which is what iOS matches on.
DEVICES = [
    (375, 667, 2),   # iPhone SE (2nd, 3rd gen), 6/7/8
    (414, 736, 3),   # iPhone 6+/7+/8 Plus
    (375, 812, 3),   # iPhone X, XS, 11 Pro, 12 mini, 13 mini
    (414, 896, 2),   # iPhone XR, 11
    (414, 896, 3),   # iPhone XS Max, 11 Pro Max
    (390, 844, 3),   # iPhone 12, 12 Pro, 13, 13 Pro, 14
    (428, 926, 3),   # iPhone 12 Pro Max, 13 Pro Max, 14 Plus
    (393, 852, 3),   # iPhone 14 Pro, 15, 15 Pro, 16
    (430, 932, 3),   # iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
    (402, 874, 3),   # iPhone 16 Pro
    (440, 956, 3),   # iPhone 16 Pro Max
]


def gradient(width, height):
    image = Image.new("RGB", (width, height))
    pixels = image.load()
    for y in range(height):
        position = y / max(1, height - 1)
        for index in range(len(STOPS) - 1):
            low, high = STOPS[index], STOPS[index + 1]
            if low[0] <= position <= high[0]:
                span = high[0] - low[0] or 1
                ratio = (position - low[0]) / span
                row = tuple(round(low[1][i] + (high[1][i] - low[1][i]) * ratio) for i in range(3))
                break
        else:
            row = STOPS[-1][1]
        for x in range(width):
            pixels[x, y] = row
    return image


def main():
    logo = Image.open(LOGO).convert("RGBA")
    written = []
    for css_width, css_height, ratio in DEVICES:
        width, height = css_width * ratio, css_height * ratio
        canvas = gradient(width, height)
        # .launch-logo is width: min(186px, 49vw). The same rule in device
        # pixels puts the wordmark at the same size the app draws a frame later.
        target = min(186 * ratio, int(width * 0.49))
        scaled = logo.resize((target, max(1, round(logo.height * target / logo.width))), Image.LANCZOS)
        canvas.paste(scaled, ((width - scaled.width) // 2, (height - scaled.height) // 2), scaled)
        name = f"splash-{width}x{height}.png"
        path = os.path.join(ASSETS, name)
        canvas.save(path, "PNG", optimize=True)
        written.append((name, os.path.getsize(path), css_width, css_height, ratio))

    print(f"  {len(written)} startup images written to pwa/assets\n")
    for name, size, css_width, css_height, ratio in written:
        print(f"  {name:<24} {size // 1024:>4} KB   {css_width}x{css_height} @{ratio}x")
    print(f"\n  total {sum(entry[1] for entry in written) // 1024} KB")
    print("\n  <link> tags for index.html:\n")
    for name, _size, css_width, css_height, ratio in written:
        print(f'    <link rel="apple-touch-startup-image" href="./assets/{name}?v=413"')
        print(f'          media="(device-width: {css_width}px) and (device-height: {css_height}px) '
              f'and (-webkit-device-pixel-ratio: {ratio}) and (orientation: portrait)">')


if __name__ == "__main__":
    main()
