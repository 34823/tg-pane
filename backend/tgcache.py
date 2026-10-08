#!/usr/bin/env python3
"""tgcache.py [folder ...] — unread counters and previews of folders into the cache (tg-counts.json in the data dir).
No folders — every named folder plus "@all" (all chats). Through Telegram Web's API, ~1 s: nothing is opened or read.
Prints the folders whose counters changed."""
import sys, time
from tglib import page, api_folders, load_cache, save_cache

names = sys.argv[1:]
with page() as pg:  # read and write the cache under the lock, so no other script's write is lost
    found = api_folders(pg, names)
    data = load_cache()
    for name in names:
        if name not in found:
            print(f"folder «{name}» not found", file=sys.stderr)
    if not names:  # a full refresh: forget folders that are gone
        data["folders"] = {k: v for k, v in data["folders"].items() if k in found}
    for name, chats in found.items():
        old = data["folders"].get(name, {})
        data["folders"][name] = {"updated": int(time.time()), "chats": chats, "unread": sum(c["unread"] for c in chats)}
        if (old.get("unread"), len(old.get("chats", []))) != (data["folders"][name]["unread"], len(chats)):
            print(f"{time.strftime('%d.%m %H:%M')} {name}: chats {len(chats)}, unread {data['folders'][name]['unread']}")
    data["order"] = list(found) if not names else data.get("order", list(data["folders"]))
    data["updated"] = int(time.time())
    save_cache(data)
