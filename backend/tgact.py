#!/usr/bin/env python3
"""tgact.py <action> <peer> <mid> [args] — one action on one message, only when the user pressed the button in the pane:
  react <peer> <mid> <emoji>   put a reaction (the same one again takes it back)
  edit <peer> <mid> <text>     change my own message (formatting is not kept)
  delete <peer> <mid>          delete my own message for everyone
  forward <peer> <mid> <to>    forward the message to chat <to> (a Telegram forward, with the source shown)
  transcribe <peer> <mid>      Telegram Premium's text of a voice message or a round video; prints the text
Each action is checked by reading the message again; a failed check exits non-zero. Nothing is marked read."""
import sys
from tglib import page, api, die

REACT_JS = """async ({peer, mid, emoji}) => { const m = appImManager.managers, p = +peer;
  const norm = s => s.replace(/\\uFE0F/g, ''), known = (await m.appReactionsManager.getAvailableReactions()).find(r => norm(r.reaction) === norm(emoji));
  if (!known) return 'no such reaction in Telegram';
  emoji = known.reaction;  // exactly as Telegram spells it
  const x = await m.appMessagesManager.getMessageByPeer(p, mid); if (!x) return 'nomessage';
  const had = (x.reactions?.results || []).some(r => r.reaction?.emoticon === emoji && r.chosen_order !== undefined);
  await m.appReactionsManager.sendReaction({message: x, reaction: {_: 'reactionEmoji', emoticon: emoji}});
  for (let i = 0; i < 30; i++) {
    const y = await m.appMessagesManager.getMessageByPeer(p, mid);
    const has = (y.reactions?.results || []).some(r => r.reaction?.emoticon === emoji && r.chosen_order !== undefined);
    if (has !== had) return 'ok';
    await new Promise(r => setTimeout(r, 150));
  } return 'unseen' }"""

EDIT_JS = """async ({peer, mid, text}) => { const A = appImManager.managers.appMessagesManager, p = +peer;
  const x = await A.getMessageByPeer(p, mid); if (!x) return 'nomessage';
  if (!x.pFlags?.out) return 'not yours';
  if (x.message === text) return 'ok';
  await A.editMessage(x, text);
  for (let i = 0; i < 30; i++) { const y = await A.getMessageByPeer(p, mid); if (y && y.message === text) return 'ok'; await new Promise(r => setTimeout(r, 150)); }
  return 'unseen' }"""

DELETE_JS = """async ({peer, mid}) => { const A = appImManager.managers.appMessagesManager, p = +peer;
  const x = await A.getMessageByPeer(p, mid); if (!x) return 'nomessage';
  if (!x.pFlags?.out) return 'not yours';
  await A.deleteMessages(p, [mid], true);
  for (let i = 0; i < 30; i++) { const y = await A.getMessageByPeer(p, mid); if (!y || y._ === 'messageEmpty') return 'ok'; await new Promise(r => setTimeout(r, 150)); }
  return 'unseen' }"""

FORWARD_JS = """async ({peer, mid, to}) => { const A = appImManager.managers.appMessagesManager, p = +peer, t = +to;
  const x = await A.getMessageByPeer(p, mid); if (!x) return 'nomessage';
  if (t < 0) { const c = await appImManager.managers.appChatsManager.getChat(-t);
    if (!c) return 'nochat'; if (c._ === 'channel' && c.pFlags?.broadcast) return 'channel (no input field)'; }
  const before = (await A.getHistory({peerId: t, limit: 1})).history[0] || 0;
  await A.forwardMessages({peerId: t, fromPeerId: p, mids: [mid]});
  for (let i = 0; i < 40; i++) {
    const h = await A.getHistory({peerId: t, limit: 1}); const id = h.history[0];
    if (id && id !== before) { const y = await A.getMessageByPeer(t, id); if (y?.fwd_from && Date.now() / 1000 - y.date < 60) return 'ok'; }
    await new Promise(r => setTimeout(r, 150));
  } return 'unseen' }"""

TRANSCRIBE_JS = """async ({peer, mid}) => { const A = appImManager.managers.appMessagesManager;
  const x = await A.getMessageByPeer(+peer, mid); if (!x) return {err: 'nomessage'};
  try { const r = await A.transcribeAudio(x, true); return {text: r.text || ''} } catch (e) { return {err: String(e.type || e).slice(0, 200)} } }"""

action, peer, mid = sys.argv[1], sys.argv[2], int(sys.argv[3])
arg = sys.argv[4] if len(sys.argv) > 4 else ""
if action in ("react", "edit", "forward") and not arg.strip():
    sys.exit(f"{action}: nothing to do without a value")
with page() as pg:
    if action == "transcribe":
        r = api(pg, TRANSCRIBE_JS, {"peer": peer, "mid": mid})
        if r.get("err"): sys.exit(f"transcription failed: {r['err']}")
        print(r["text"] or "[no speech recognised]"); sys.exit(0)
    res = {"react": lambda: api(pg, REACT_JS, {"peer": peer, "mid": mid, "emoji": arg}),
           "edit": lambda: api(pg, EDIT_JS, {"peer": peer, "mid": mid, "text": arg}),
           "delete": lambda: api(pg, DELETE_JS, {"peer": peer, "mid": mid}),
           "forward": lambda: api(pg, FORWARD_JS, {"peer": peer, "mid": mid, "to": arg})}.get(action)
    if res is None: sys.exit(f"unknown action {action}")
    out = res()
if out != "ok": sys.exit(f"{action} failed: {out}")
print("ok")
