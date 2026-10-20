#!/usr/bin/env python3
"""tgsearch.py "<words>" [N] — search the text of messages in every chat (Telegram's global search); prints JSON
{hits: [{peer, title, mid, date, time, out, text}]}, newest first. Nothing is opened, nothing marked read.
(Search inside one chat is tgchat.py <peer> --query "<words>".)"""
import json, sys
from datetime import datetime
from tglib import page, api, clean, zone, PEER_JS

JS = """async ({q, n}) => { const m = appImManager.managers, peer = """ + PEER_JS + """;
  const h = await m.appMessagesManager.getHistory({peerId: undefined, query: q, inputFilter: {_: 'inputMessagesFilterEmpty'}, limit: n}), out = [];
  for (const x of h.messages || []) {
    if (!x || !x.peerId) continue;
    out.push({peer: String(x.peerId), title: (await peer(m, +x.peerId)).title, mid: x.mid, date: x.date, out: !!x.pFlags?.out,
              text: (x.media && x.media._ !== 'messageMediaWebPage' ? '[media] ' : '') + (x.message || '')});
  } return out; }"""

q = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 20
with page() as pg:
    hits = api(pg, JS, {"q": q, "n": n})
for h in hits:
    t = datetime.fromtimestamp(h["date"], zone())
    h["date"], h["time"], h["title"] = f"{t.day}.{t.month:02d}", t.strftime("%H:%M"), clean(h["title"])
    h["text"] = h["text"].replace("\n", " ")[:300]
print(json.dumps({"hits": hits}, ensure_ascii=False))
