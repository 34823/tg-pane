#!/usr/bin/env python3
"""tgchat.py <peer id> [N] [--read] [--before <mid>] — chat history as JSON for the pane:
{peer, title, kind, unread, messages: [{mid, date, time, out, text}]}, the last N (default 40), or the N older
than message <mid>. Through Telegram Web's API: the chat is not opened, the other person does not see "read".
--read — mark it read first (only when the user asks). Peer ids come from the cache (tgcache.py)."""
import json, sys
from tglib import page, api_chat, api_mark_read

args, before = [], 0
it = iter(sys.argv[1:])
for a in it:
    if a == "--before": before = int(next(it))
    elif a != "--read": args.append(a)
peer = args[0]
n = int(args[1]) if len(args) > 1 else 40
with page() as pg:
    if "--read" in sys.argv:
        api_mark_read(pg, peer)
    h = api_chat(pg, peer, n, before)
print(json.dumps({"peer": peer, **h}, ensure_ascii=False))
