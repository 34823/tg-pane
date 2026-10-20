"""Shared code for the tg-pane backend: talks to a logged-in Telegram Web (web.telegram.org/k) in a headless
Chromium over CDP. Everything is read through Telegram Web's own internal API (appImManager.managers), the same
calls its UI makes: no clicks, no chat is opened, nothing is marked read unless asked. One script at a time
goes into the browser (a file lock). Opening a chat (only to send a message) — open_peer/close_chat.

Settings: env TG_PANE_DATA (data dir, default ~/.local/share/tg-pane) holds the lock, the counters cache,
the browser profile and an optional config.json {"port": 9444, "tz": "Europe/Moscow"}; env TG_PANE_PORT and
TG_PANE_TZ override it.

Exit codes the pane understands: 75 — Telegram FLOOD_WAIT (slow down), 76 — the browser does not answer,
77 — not logged in to Telegram Web."""
import fcntl, json, os, re, sys, time
from contextlib import contextmanager
from datetime import datetime

DATA = os.path.expanduser(os.environ.get("TG_PANE_DATA") or "~/.local/share/tg-pane")
try:
    CONFIG = json.load(open(os.path.join(DATA, "config.json")))
except (OSError, ValueError):
    CONFIG = {}
PORT = int(os.environ.get("TG_PANE_PORT") or CONFIG.get("port") or 9444)
TZ = os.environ.get("TG_PANE_TZ") or CONFIG.get("tz") or None
LOCK = os.path.join(DATA, ".tg.lock")
CACHE = os.path.join(DATA, "tg-counts.json")
PROFILE = os.path.join(DATA, "profile")
ALL = "@all"  # pseudo-folder: all chats (not archived), for people without folders
FLOOD, DOWN, LOGGED_OUT = 75, 76, 77

MSGS_JS = """() => { const out = [];
  document.querySelectorAll('.chat.active .bubbles-date-group').forEach(g => {
    const date = g.querySelector('.bubble.is-date .service-msg, .bubble.service .service-msg')?.innerText?.trim() || '';
    g.querySelectorAll('.bubble[data-mid]').forEach(b => {
      if (b.classList.contains('is-date')) return;
      const m = b.querySelector('.message');
      const clone = m ? m.cloneNode(true) : null;
      if (clone) clone.querySelectorAll('.time, .reactions, .inner, .post-views').forEach(e => e.remove());
      const text = ((clone || b).innerText || '').trim();
      const media = b.querySelector('.media-container, .album-item') ? '[media] ' : '';
      out.push({mid: +b.dataset.mid, date, time: b.querySelector('.time')?.innerText?.trim() || '',
                out: b.classList.contains('is-out'), text: media + text});
    });
  }); return out; }"""


def clean(s):  # drop glyphs from the Unicode private use area (check marks, premium badges)
    return re.sub(r"[-]", "", s).strip()


def zone():
    from zoneinfo import ZoneInfo
    return ZoneInfo(TZ) if TZ else None


def die(code, text):
    print(text, file=sys.stderr); sys.exit(code)


@contextmanager
def page(wait=120):
    """The Telegram Web page under the lock: only one script talks to the browser at a time."""
    os.makedirs(DATA, exist_ok=True)
    fd = os.open(LOCK, os.O_CREAT | os.O_RDWR, 0o600)
    end = time.time() + wait
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); break
        except BlockingIOError:
            if time.time() > end: sys.exit("the Telegram browser is busy with another script")
            time.sleep(1)
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                ctx = p.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}", timeout=30000).contexts[0]
                pg = next((x for x in ctx.pages if "web.telegram.org" in x.url), None) or ctx.pages[0]
            except Exception as e:  # the pane restarts the browser on this code
                die(DOWN, f"the Telegram browser does not answer (port {PORT}): {str(e).splitlines()[0][:120]}")
            if not wait_ready(pg):
                die(LOGGED_OUT, "not logged in to Telegram Web — run: tgbrowser.py login")
            try:
                yield pg
            finally:  # whatever happens, never leave a chat open (new messages would become "read")
                try:
                    if pg.evaluate("() => appImManager.chat?.peerId"): close_chat(pg)
                except Exception:
                    pass
    finally:
        os.close(fd)


def wait_ready(pg, ms=15000):
    """True once Telegram Web's chat list is up; False if it shows the login page."""
    end = time.time() + ms / 1000
    while time.time() < end:
        state = pg.evaluate("""() => window.appImManager?.managers && document.querySelector('#column-left') ? 'ok'
          : document.querySelector('#auth-pages .tabs-tab.active, .page-signQR, .page-sign, .page-password') ? 'login' : ''""")
        if state: return state == "ok"
        pg.wait_for_timeout(500)
    return False


def reset(pg):
    """Close an open chat/menu and the search, if left open."""
    for _ in range(3):
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    if pg.locator("#search-container.active").count():  # close the search with the "back" arrow
        pg.mouse.click(50, 43); pg.wait_for_timeout(800)


def open_peer(pg, peer):
    """Open a chat by peer id (marks it read!). Returns its title or None."""
    pg.evaluate("p => appImManager.setInnerPeer({peerId: p.toPeerId ? p.toPeerId() : +p})", str(peer))
    pg.wait_for_timeout(2500)
    if str(pg.evaluate("() => appImManager.chat?.peerId")) != str(peer):
        return None
    return clean(pg.locator(".chat.active .chat-info .peer-title").first.inner_text())


def close_chat(pg):
    """Close the chat so new incoming messages are not marked read while nobody looks."""
    pg.keyboard.press("Escape"); pg.wait_for_timeout(800)
    if pg.evaluate("() => appImManager.chat?.peerId"):
        pg.keyboard.press("Escape"); pg.wait_for_timeout(800)


PEER_JS = """async (m, p) => { if (p > 0) { const u = await m.appUsersManager.getUser(p);
    if (u?.pFlags?.self) return {title: 'Saved Messages', kind: 'self'};
    return {title: [u?.first_name, u?.last_name].filter(Boolean).join(' ') || 'Deleted Account', kind: u?.pFlags?.bot ? 'bot' : 'user'}; }
  const c = await m.appChatsManager.getChat(-p);
  return {title: c?.title || '', kind: c?._ === 'channel' && c?.pFlags?.broadcast ? 'channel' : 'group'} }"""

# Named folders in Telegram's order (no names = all of them; titles without a letter or digit are spacers) and "@all".
FOLDERS_API_JS = """async ({names, limit}) => { const m = appImManager.managers, peer = """ + PEER_JS + """;
  const fs = (await m.filtersStorage.getDialogFilters()).filter(f => f.id > 1)
    .map(f => ({id: f.id, name: f.title?.text ?? f.title ?? ''})).filter(f => /[\\p{L}\\p{N}]/u.test(f.name));
  const want = names.length ? names.map(n => n === '@all' ? {id: 0, name: n} : fs.find(f => f.name === n)).filter(Boolean)
                            : [...fs, {id: 0, name: '@all'}];
  const out = {};
  for (const f of want) {
    const d = await m.dialogsStorage.getDialogs({filterId: f.id, limit});
    out[f.name] = [];
    for (const z of d.dialogs.slice(0, limit)) {
      const t = z.topMessage || {}, info = await peer(m, z.peerId);
      out[f.name].push({id: String(z.peerId), title: info.title, kind: info.kind, date: t.date || 0,
        last: (t.media && t.media._ !== 'messageMediaWebPage' ? '[media] ' : '') + (t.message || ''),
        unread: z.unread_count || (z.pFlags?.unread_mark ? 1 : 0),
        muted: (z.notify_settings?.mute_until || 0) > Date.now() / 1000});
    }
  } return out; }"""

HISTORY_API_JS = """async ({peer, n, before}) => { const m = appImManager.managers, p = +peer, info = await (""" + PEER_JS + """)(m, p);
  const h = await m.appMessagesManager.getHistory({peerId: p, limit: n, offsetId: before || 0}), out = [], names = {};
  for (const mid of h.history) {
    const x = await m.appMessagesManager.getMessageByPeer(p, mid);
    if (!x) continue;
    const text = x._ === 'messageService' ? '[service]' : (x.media && x.media._ !== 'messageMediaWebPage' ? '[media] ' : '') + (x.message || '');
    const msg = {mid, date: x.date, out: !!x.pFlags?.out, text};
    const md = x.media?._ === 'messageMediaPhoto' ? 'photo' : x.media?._ === 'messageMediaDocument' ?
      (/^image\\//.test(x.media.document?.mime_type || '') ? 'image' : /^video\\//.test(x.media.document?.mime_type || '') ? 'video' : 'file') : '';
    if (md) msg.media = md;
    if (info.kind === 'group' && !msg.out && x.fromId) {  // who wrote it, in a group
      names[x.fromId] ??= (await (""" + PEER_JS + """)(m, +x.fromId)).title;
      msg.from = names[x.fromId];
    }
    out.push(msg);
  }
  const d = await m.dialogsStorage.getDialogOnly(p);
  return {title: info.title, kind: info.kind, unread: d?.unread_count || 0, messages: out.reverse()}; }"""

FIND_API_JS = """async ({name, limit}) => { const m = appImManager.managers, peer = """ + PEER_JS + """, q = name.toLowerCase();
  for (const filterId of [0, 1]) {  // 0 — all chats, 1 — archive
    const d = await m.dialogsStorage.getDialogs({filterId, limit});
    for (const z of d.dialogs) {
      const t = (await peer(m, z.peerId)).title;
      if (t.toLowerCase().includes(q)) return {id: String(z.peerId), title: t, unread: z.unread_count || 0};
    }
  } return null; }"""

READ_API_JS = """async ({peer, upTo}) => { const m = appImManager.managers, p = +peer;
  const d = await m.dialogsStorage.getDialogOnly(p), maxId = upTo || d?.top_message;
  if (maxId) await m.appMessagesManager.readHistory({peerId: p, maxId}); }"""


def api(pg, js, arg):
    try:
        return pg.evaluate(js, arg)
    except Exception as e:
        if "FLOOD_WAIT" in str(e):
            die(FLOOD, f"FLOOD_WAIT: Telegram asks to slow down ({str(e)[:120]})")
        raise


def tg_time(sec, now=None):
    """Time for the chat list: today "12:05", earlier "20.10" (day.month, no weekday names), another year "20.10.25"."""
    if not sec: return ""
    t, now = datetime.fromtimestamp(sec, zone()), now or datetime.now(zone())
    if t.date() == now.date(): return t.strftime("%H:%M")
    if t.year == now.year: return f"{t.day}.{t.month:02d}"
    return f"{t.day}.{t.month:02d}.{t.year % 100:02d}"


def api_folders(pg, names=(), limit=100):
    """Chats of folders: {folder: [{id, title, kind, time, last, unread, muted}]}. No names — every named folder and "@all"."""
    out = api(pg, FOLDERS_API_JS, {"names": list(names), "limit": limit})
    for chats in out.values():
        for c in chats:
            c["time"] = tg_time(c.pop("date")); c["title"] = clean(c["title"]); c["last"] = c["last"].replace("\n", " ")[:300]
    return out


def api_history(pg, peer, n, before=0):
    """Title and the last n messages of a chat (older than message `before`, if given). Opens nothing, marks nothing read.
    Returns (title, messages) — the full answer with kind and unread is api_chat. A group's messages carry `from`."""
    h = api_chat(pg, peer, n, before)
    return h["title"], h["messages"]


def api_chat(pg, peer, n, before=0):
    h = api(pg, HISTORY_API_JS, {"peer": str(peer), "n": n, "before": before})
    for m in h["messages"]:
        t = datetime.fromtimestamp(m["date"], zone())
        m["date"], m["time"] = f"{t.day}.{t.month:02d}", t.strftime("%H:%M")
        if "from" in m: m["from"] = clean(m["from"])
    h["title"] = clean(h["title"])
    return h


def api_find(pg, name, limit=300):
    """A chat by part of its name among all chats and the archive: {id, title, unread} or None. Opens nothing."""
    r = api(pg, FIND_API_JS, {"name": name, "limit": limit})
    if r: r["title"] = clean(r["title"])
    return r


def api_mark_read(pg, peer, up_to=0):
    """Mark a chat read up to its last message (or message `up_to`) — the call the UI makes when you scroll down.
    In a private chat the other person will see "read"."""
    api(pg, READ_API_JS, {"peer": str(peer), "upTo": up_to})
    zero_unread(peer)


def zero_unread(peer):
    """The chat is read — zero its counter in the cache right away, without waiting for tgcache.py."""
    data = load_cache()
    for f in data["folders"].values():
        for c in f["chats"]:
            if c["id"] == str(peer): c["unread"] = 0
        f["unread"] = sum(c["unread"] for c in f["chats"])
    save_cache(data)


def load_cache():
    try:
        return json.load(open(CACHE))
    except (OSError, ValueError):
        return {"folders": {}}


def save_cache(data):
    os.makedirs(DATA, exist_ok=True)
    tmp = CACHE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False)
    os.chmod(tmp, 0o600); os.replace(tmp, CACHE)
