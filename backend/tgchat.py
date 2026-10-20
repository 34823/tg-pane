#!/usr/bin/env python3
"""tgchat.py <peer id> [N] [--read] [--before <mid>] [--around <mid>] [--after <mid>] [--query <words>] — chat history as JSON
for the pane: {peer, title, kind, unread, messages: [{mid, date, time, out, text}]}, the last N (default 40), or the N older
than message <mid>, or a window around <mid>, or the N newer than <mid>, or (--query) the messages with these words, newest
first in Telegram's search order. Through Telegram Web's API: the chat is not opened, the other person does not see "read".
--read — mark it read first (only when the user asks). Peer ids come from the cache (tgcache.py)."""
import json, sys
from tglib import page, api_chat, api_mark_read

args, opts = [], {"--before": 0, "--around": 0, "--after": 0, "--query": ""}
it = iter(sys.argv[1:])
for a in it:
    if a in opts: opts[a] = type(opts[a])(next(it))
    elif a != "--read": args.append(a)
peer = args[0]
n = int(args[1]) if len(args) > 1 else 40
with page() as pg:
    if "--read" in sys.argv:
        api_mark_read(pg, peer)
    h = api_chat(pg, peer, n, opts["--before"], opts["--query"], opts["--around"], opts["--after"])
print(json.dumps({"peer": peer, **h}, ensure_ascii=False))
