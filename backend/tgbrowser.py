#!/usr/bin/env python3
"""tgbrowser.py start | stop | status | login | password — the headless Chromium with Telegram Web for tg-pane.

start     start it (profile in <data dir>/profile, debug port from config), if it is not running yet
stop      stop it
status    JSON: {"running", "state": ok|qr|password|loading|down, "qr": [rows of 0/1] while it shows a QR code}
login     interactive: prints the QR code in the terminal until you scan it (Telegram on the phone →
          Settings → Devices → Link Desktop Device); asks for the cloud password if the account has one
password  reads the cloud password from stdin and submits it (the pane does this)

Chromium is the one Playwright installs (python -m playwright install chromium)."""
import json, os, signal, subprocess, sys, time, urllib.request
from tglib import PORT, PROFILE, TZ

URL = "https://web.telegram.org/k/"

STATE_JS = """() => window.appImManager?.managers && document.querySelector('#column-left') ? 'ok'
  : [...document.querySelectorAll('input[type=password]')].some(e => e.offsetParent) ? 'password'
  : document.querySelector('canvas[class*=qrCanvas]') ? 'qr' : 'loading'"""

# The QR code from Telegram's canvas as rows of "1"/"0": find the code's box, guess the version by
# matching the three finder squares, then sample the middle of every module (the logo reads as light).
QR_JS = """() => { const c = document.querySelector('canvas[class*=qrCanvas]'); if (!c || !c.width) return null;
  const W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const dark = (x, y) => { const i = (Math.floor(y) * W + Math.floor(x)) * 4;
    return d[i + 3] > 128 && d[i] * .3 + d[i + 1] * .59 + d[i + 2] * .11 < 100; };
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (dark(x, y)) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) return null;
  const F = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
  let best = null;
  for (let v = 1; v <= 40; v++) { const n = 4 * v + 17, s = (x1 - x0 + 1) / n; if (s < 2) break;
    let score = 0;
    for (const [cx, cy] of [[0, 0], [n - 7, 0], [0, n - 7]])
      for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++)
        if (dark(x0 + (cx + j + .5) * s, y0 + (cy + i + .5) * s) === (F[i][j] === '1')) score++;
    if (!best || score > best.score) best = {score, n, s}; }
  const n = best.n, finder = (i, j) => [[0, 0], [n - 7, 0], [0, n - 7]].map(([cx, cy]) => F[i - cy]?.[j - cx]).find(Boolean);
  const rows = [];
  for (let i = 0; i < n; i++) { let r = '';  // the finder squares are drawn rounded — put back their standard shape
    for (let j = 0; j < n; j++) r += finder(i, j) ?? (dark(x0 + (j + .5) * best.s, y0 + (i + .5) * best.s) ? '1' : '0');
    rows.push(r); }
  return rows; }"""


def alive():
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=3).read(); return True
    except OSError:
        return False


def start():
    if alive():
        return print(f"already running (port {PORT})")
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        chrome = p.chromium.executable_path
    os.makedirs(PROFILE, exist_ok=True); os.chmod(PROFILE, 0o700)
    env = {**os.environ, **({"TZ": TZ} if TZ else {})}
    # headless Chromium announces "HeadlessChrome" in its User-Agent, which some sites reject — announce plain Chrome
    ver = subprocess.run([chrome, "--version"], capture_output=True, text=True).stdout.split()[-1]
    ua = f"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{ver} Safari/537.36"
    args = [chrome, "--headless=new", f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
            "--window-size=1280,900", f"--user-agent={ua}", URL] + (["--no-sandbox"] if os.geteuid() == 0 else [])
    subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)  # detached: outlives this script and the pane
    for _ in range(30):
        if alive(): return print(f"started (port {PORT}, profile {PROFILE})")
        time.sleep(0.5)
    sys.exit("Chromium did not start")


def stop():
    for pid in os.listdir("/proc"):
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
        except (OSError, ValueError):
            continue
        if f"--remote-debugging-port={PORT}".encode() in cmd and not any(a.startswith(b"--type=") for a in cmd):
            os.kill(int(pid), signal.SIGTERM); print(f"stopped (pid {pid})")


def tg_page(p):
    ctx = p.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}", timeout=30000).contexts[0]
    return next((x for x in ctx.pages if "web.telegram.org" in x.url), None) or ctx.pages[0]


def status():
    if not alive():
        return {"running": False, "state": "down"}
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        pg = tg_page(p)
        state = pg.evaluate(STATE_JS)
        return {"running": True, "state": state, **({"qr": pg.evaluate(QR_JS)} if state == "qr" else {})}


def password(pw):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        pg = tg_page(p)
        box = next((b for b in pg.locator("input[type=password]").all() if b.is_visible()), None)
        if not box:
            sys.exit("no password field on the page")
        box.fill(pw); box.press("Enter"); pg.wait_for_timeout(4000)
        state = pg.evaluate(STATE_JS)
        if state == "password":
            sys.exit("wrong password?")
        print(state)


def show_qr(rows):
    """Two modules per character (▀), black on white with a quiet zone — any phone camera reads it."""
    n = len(rows) + 4
    rows = ["0" * n] * 2 + [f"00{r}00" for r in rows] + ["0" * n] * 3
    out = ["\033[2J\033[H"]
    for i in range(0, n + 1, 2):
        line = "".join("\033[3%dm\033[4%dm▀" % (0 if rows[i][j] == "1" else 7, 0 if rows[i + 1][j] == "1" else 7) for j in range(n))
        out.append(line + "\033[0m")
    print("\n".join(out) + "\nTelegram on your phone → Settings → Devices → Link Desktop Device, then scan.", flush=True)


def login():
    start()
    last = None
    while True:
        s = status()
        if s["state"] == "ok":
            return print("logged in")
        if s["state"] == "password":
            import getpass
            password(getpass.getpass("Telegram cloud password: ")); continue
        if s.get("qr") and s["qr"] != last:
            show_qr(s["qr"]); last = s["qr"]
        time.sleep(2)


cmd = sys.argv[1] if len(sys.argv) > 1 else ""
if cmd == "start": start()
elif cmd == "stop": stop()
elif cmd == "status": print(json.dumps(status()))
elif cmd == "login": login()
elif cmd == "password": password(sys.stdin.read().rstrip("\n"))
else: sys.exit(__doc__)
