#!/usr/bin/env python3
"""tgmsg.py "<chat name>" "<text>" [--dry] — send one message from Telegram Web.
tgmsg.py --peer <peer id> "<text>" [--dry] — the same by chat id (from the cache); this is how the pane sends.
Only what the user typed. Checks the chat, sends one message, checks it went out."""
import sys
from tglib import page, reset, open_peer, close_chat, zero_unread, api_mark_read, api, MSGS_JS

args = [a for a in sys.argv[1:] if a != "--dry"]
dry = "--dry" in sys.argv
peer = args[1] if args[0] == "--peer" else None
name, text = (None, args[2]) if peer else (args[0], args[1])
if not text.strip():
    sys.exit("empty text — not sending")
# By id: through Telegram Web's own sendText, no chat opened, no fixed waits (~0.1 s instead of ~12 s).
SEND_JS = """async ({peer, text}) => { const m = appImManager.managers.appMessagesManager, p = +peer;
  if (p < 0) { const c = await appImManager.managers.appChatsManager.getChat(-p);
    if (!c) return 'nochat';
    if (c._ === 'channel' && c.pFlags?.broadcast) return 'channel (no input field)'; }
  await m.sendText({peerId: p, text});
  for (let i = 0; i < 40; i++) {
    const h = await m.getHistory({peerId: p, limit: 3});
    for (const id of h.history) {
      const x = await m.getMessageByPeer(p, id);
      if (x && x.message === text && Date.now() / 1000 - x.date < 60) return 'ok';
    }
    await new Promise(r => setTimeout(r, 100));
  } return 'unseen' }"""

with page() as pg:
    if peer and not dry:
        res = api(pg, SEND_JS, {"peer": peer, "text": text})
        if res == "ok":
            api_mark_read(pg, peer)  # replied = the chat is read
            print("sent"); sys.exit(0)
        sys.exit("cannot see the sent message in the chat — check it" if res == "unseen" else f"send failed: {res}")
    if peer:
        reset(pg)
        title = open_peer(pg, peer)
        if title is None:
            sys.exit(f"chat {peer} did not open — not sending")
    else:
        pg.keyboard.press("Escape")
        row = pg.locator("a.chatlist-chat", has_text=name).first
        if row.count() == 0:
            pg.locator("input.input-search-input").first.click()
            pg.keyboard.type(name, delay=60)
            pg.wait_for_timeout(2500)
            row = pg.locator(".search-group a.chatlist-chat", has_text=name).first
        if row.count() == 0:
            sys.exit(f"chat «{name}» not found")
        row.click()
        pg.wait_for_timeout(2000)
        title = pg.locator(".chat-info .peer-title").first.inner_text().strip()
        if name.lower() not in title.lower():
            sys.exit(f"opened «{title}», not «{name}» — not sending")
    print(f"chat: {title}")
    if dry:
        if peer: close_chat(pg)
        print("dry run: not sent"); sys.exit(0)
    box = pg.locator(".chat.active .input-message-input").first
    if not box.count() or not box.is_visible():
        close_chat(pg)
        sys.exit("you cannot write to this chat (a channel?) — not sent")
    box.click()
    box.focus()  # the newer tiptap editor of Telegram Web does not take focus from a click alone
    pg.keyboard.insert_text(text)  # whole, like a paste: fast, and a newline will not send a piece early
    pg.wait_for_timeout(600)
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(2000)
    if peer:
        last = [m for m in pg.evaluate(MSGS_JS) if m["out"]][-1:]
        close_chat(pg)
        if not last or text.strip()[:40] not in last[0]["text"]:
            sys.exit("cannot see the sent message in the chat — check it")
        zero_unread(peer)  # replied = the chat is read
    print("sent")
