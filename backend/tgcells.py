#!/usr/bin/env python3
"""tgcells.py <png> <max cols> <max rows> — a picture as terminal cells for the pane's Raster: two pixels per cell
(▀, top in the foreground, bottom in the background), fitted to the box, aspect kept. Prints JSON {columns, rows, cells}
where cells is base64 of little-endian uint32 triples (char, fg 0xRRGGBB, bg 0xRRGGBB). Needs Pillow."""
import base64, json, struct, sys
from PIL import Image

path, mc, mr = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
im = Image.open(path).convert("RGB")
w, h = im.size
c = min(mc, int(mr * 2 * w / h)); c = max(1, c)
r = max(1, min(mr, round(c * h / w / 2)))
im = im.resize((c, r * 2), Image.LANCZOS)
px = im.load()
out = bytearray()
for y in range(r):
    for x in range(c):
        t, b = px[x, 2 * y], px[x, 2 * y + 1]
        out += struct.pack("<III", 0x2580, t[0] << 16 | t[1] << 8 | t[2], b[0] << 16 | b[1] << 8 | b[2])
print(json.dumps({"columns": c, "rows": r, "cells": base64.b64encode(bytes(out)).decode()}))
