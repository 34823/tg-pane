#!/usr/bin/env python3
"""tgunread.py "<folder>" [--max-chats N] [--per-chat M] [--mark-only] — unread posts of a folder's channels and
groups as one text, for a model to summarize (the pane's "Summary" button). Reads the history and marks it read.
tgunread.py --peer <id> [--per-chat M] — the same for one chat (its unread, at least the last 10 posts).
tgunread.py --private ["<folder>"] — unread private chats (of the folder, or every chat with a person or a bot).
--mark-only — only mark them read, print nothing but the count.
Private chats are never marked read here (the other person would see "read"): a private chat (id > 0), the folder
in env TG_PANE_PRIVATE or "--private" — read and printed only. In other folders private chats are only named.
--since day|week|month — not the unread but everything posted in that period (per chat at most 150 posts, 15 chats, texts cut);
marks NOTHING read, private chats are not opened (for a person's chat with --peer it is read only).
Pauses between chats — do not hammer Telegram. Updates the folder's counters in the cache at the end."""
import os, sys, time
from tglib import ALL, page, api_chat, api_folders, api_mark_read, load_cache, save_cache

args = [a for a in sys.argv[1:] if not a.startswith("--")]
opt = lambda k, d: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
max_chats, per_chat = int(opt("--max-chats", 15)), int(opt("--per-chat", 40))
peer, mark_only = opt("--peer", None), "--mark-only" in sys.argv
since = opt("--since", None)
if since not in (None, "day", "week", "month"):
    sys.exit("--since takes day, week or month")
args = [a for a in args if a != since]  # the word after --since is not a folder name
if peer: args = []
name = args[0] if args else None
private_names = {"личные", "private", (os.environ.get("TG_PANE_PRIVATE") or "").lower()} - {""}
private = "--private" in sys.argv or bool(name and name.lower() in private_names) or bool(peer and not peer.startswith("-"))
if private and mark_only:
    sys.exit("private chats are not marked read in bulk")
if private and not peer and not name:
    name = ALL

PERIOD_CHATS, PERIOD_POSTS, PERIOD_CHARS, PERIOD_TOTAL = 15, 150, 600, 60000


def period(pg, todo, name, days):
    """Print everything the chats posted in the last `days` days; reads only, nothing is marked read."""
    cutoff = time.time() - days * 86400
    print(f"# {name}: posts of the last {since} ({len(todo)} chats, at most {PERIOD_POSTS} posts each, nothing marked read)")
    total = 0
    for c in todo:
        got, before = [], 0
        while len(got) < PERIOD_POSTS:
            h = api_chat(pg, c["id"], 50, before)
            page_ = h["messages"]
            if not page_: break
            got = [m for m in page_ if m["ts"] >= cutoff] + got
            before = page_[0]["mid"]
            if page_[0]["ts"] < cutoff: break
            pg.wait_for_timeout(600)
        got = got[-PERIOD_POSTS:]
        if not got: continue
        print(f"\n## {c['title']} (posts {len(got)})")
        for m in got:
            who = "me: " if m["out"] and h["kind"] != "channel" else f"{m['from']}: " if m.get("from") else ""
            line = f"{m['date']} {m['time']} {who}{m['text'][:PERIOD_CHARS]!r}"
            total += len(line)
            if total > PERIOD_TOTAL: print("# ...output cut: too long"); return
            print(line)
        pg.wait_for_timeout(1000)


with page() as pg:
    if since:
        days = {"day": 1, "week": 7, "month": 30}[since]
        if peer:
            h = api_chat(pg, peer, 1)
            period(pg, [{"id": peer, "title": h["title"]}], f"«{h['title']}»", days)
        else:
            rows = api_folders(pg, [name or ALL]).get(name or ALL)
            if rows is None:
                sys.exit(f"folder «{name}» not found")
            cutoff = time.time() - days * 86400
            todo = sorted([c for c in rows if c["id"].startswith("-") and c["ts"] >= cutoff], key=lambda c: -c["ts"])[:PERIOD_CHATS]
            period(pg, todo, name or ALL, days)
        sys.exit(0)
    if peer:
        h = api_chat(pg, peer, 1)
        todo, people = [{"id": peer, "title": h["title"], "unread": h["unread"]}], []
    else:
        rows = api_folders(pg, [name]).get(name)
        if rows is None:
            sys.exit(f"folder «{name}» not found")
        todo = [c for c in rows if c["unread"]]
        if private and name == ALL:  # every chat with a person or a bot
            todo = [c for c in todo if not c["id"].startswith("-")]
        people = [] if private else [c for c in todo if not c["id"].startswith("-")]
        todo = sorted([c for c in todo if private or c["id"].startswith("-")], key=lambda c: -c["unread"])[:max_chats]
    if mark_only:
        for c in todo:
            api_mark_read(pg, c["id"]); pg.wait_for_timeout(500)
        print(f"marked read: {len(todo)}")
    else:
        what = f"«{todo[0]['title']}»" if peer else "private chats" if private and name == ALL else name
        print(f"# {what}: chats with unread {len(todo)}, unread total {sum(c['unread'] for c in todo)}"
              + (" (private: not marked read)" if private else ""))
        if people:
            print(f"# private chats in the folder were not opened: {', '.join(c['title'] + ' (' + str(c['unread']) + ')' for c in people)}")
        for c in todo:
            n = min(max(c["unread"], 10 if peer else 3), per_chat)
            h = api_chat(pg, c["id"], n)
            title, msgs = h["title"], h["messages"]
            if not private:
                api_mark_read(pg, c["id"], max((m["mid"] for m in msgs), default=0))  # not a post that came in meanwhile
            print(f"\n## {title} (unread {c['unread']}, shown {len(msgs)})")
            for m in msgs:
                who = "me: " if m["out"] and h["kind"] != "channel" else f"{m['from']}: " if m.get("from") else ""
                print(f"{m['date']} {m['time']} {who}{m['text'][:1500]!r}")
            pg.wait_for_timeout(1000)
    if not peer and not private:  # under the lock, so no other script's cache write is lost
        after = api_folders(pg, [name])[name]
        data = load_cache()
        data["folders"][name] = {"updated": int(time.time()), "chats": after, "unread": sum(c["unread"] for c in after)}
        save_cache(data)
