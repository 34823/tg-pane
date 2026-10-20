#!/usr/bin/env python3
"""tgmedia.py <peer id> <mid> — download one message's picture (photo, image file, or a video's preview) to
<data dir>/media/ and print the PNG path. Only on request (the pane's «open» button); nothing is marked read.
PNG because the Kitty graphics protocol takes PNG; a JPEG is converted with Pillow if it is there."""
import base64, os, sys
from tglib import page, DATA

JS = """async ({peer, mid}) => { const m = appImManager.managers, p = +peer;
  const x = await m.appMessagesManager.getMessageByPeer(p, mid);
  const md = x?.media; if (!md) return {err: 'no media'};
  let media, thumb;
  if (md._ === 'messageMediaPhoto') {
    media = md.photo;
    thumb = [...media.sizes].filter(s => s.w).sort((a, b) => b.w - a.w).find(s => s.w <= 1600) || media.sizes[media.sizes.length - 1];
  } else if (md._ === 'messageMediaDocument') {
    media = md.document;
    if (/^image\\//.test(media.mime_type || '')) { if (media.size > 20e6) return {err: 'file too big'}; }
    else { const t = (media.thumbs || []).filter(s => s.w).sort((a, b) => b.w - a.w)[0]; if (!t) return {err: 'no preview'}; thumb = t; }
  } else return {err: 'no picture'};
  const b = await appDownloadManager.downloadMedia(thumb ? {media, thumb} : {media});
  const buf = new Uint8Array(await b.arrayBuffer()); let s = '';
  for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192));
  return {b64: btoa(s), type: b.type}; }"""

peer, mid = sys.argv[1], int(sys.argv[2])
out_dir = os.path.join(DATA, "media")
os.makedirs(out_dir, exist_ok=True)
out = os.path.join(out_dir, f"{peer}_{mid}.png")
if not os.path.exists(out):
    with page() as pg:
        r = pg.evaluate(JS, {"peer": peer, "mid": mid})
    if r.get("err"): sys.exit(r["err"])
    raw = base64.b64decode(r["b64"])
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        open(out, "wb").write(raw)
    else:
        import io
        from PIL import Image  # JPEG/WebP -> PNG
        Image.open(io.BytesIO(raw)).convert("RGBA" if raw[:4] == b"RIFF" else "RGB").save(out)
print(out)
