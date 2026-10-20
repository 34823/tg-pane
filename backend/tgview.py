#!/usr/bin/env python3
"""tgview.py show <png> <panel cols> | clear — draw a picture over the pane with Kitty graphics, straight into the terminal
of the Claude Code session this runs under (found by walking up the parents to the first /dev/pts). The pane right-aligns
to the terminal's edge, so the box is the last <panel cols> columns, below the header; the picture is fitted and centred."""
import base64, fcntl, os, struct, sys, termios

def tty():
    pid = os.getpid()
    while pid > 1:
        try:
            p = os.readlink(f"/proc/{pid}/fd/0")
            if p.startswith("/dev/pts/"): return p
            pid = int(open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[1])
        except OSError: break
    sys.exit("no terminal found")

DEL = "\x1b_Ga=d,d=a,q=2\x1b\\"
out = open(tty(), "w")
if sys.argv[1] == "clear":
    out.write(DEL); out.flush(); sys.exit()

path, pcols = sys.argv[2], int(sys.argv[3])
raw = open(path, "rb").read()
pw, ph = struct.unpack(">II", raw[16:24])
rows_t, cols_t, xpix, ypix = struct.unpack("HHHH", fcntl.ioctl(out.fileno(), termios.TIOCGWINSZ, b"\0" * 8))
top, mc, mr = 3, max(4, pcols - 2), max(4, rows_t - 8)
# a cell is about 1:2, so columns:rows of the picture is (pw/ph)*2
c = min(mc, int(mr * 2 * pw / ph)); r = max(1, min(mr, int(c * ph / pw / 2)))
left = cols_t - pcols + (mc - c) // 2 + 2
top += (mr - r) // 2
data = base64.standard_b64encode(raw).decode()
ch = [data[i:i + 4096] for i in range(0, len(data), 4096)]
out.write(DEL + f"\x1b7\x1b[{top};{left}H")
out.write("".join(f"\x1b_G{'a=T,f=100,c=%d,r=%d,C=1,q=2,' % (c, r) if i == 0 else ''}m={1 if i < len(ch) - 1 else 0};{p}\x1b\\" for i, p in enumerate(ch)))
out.write("\x1b8"); out.flush()
