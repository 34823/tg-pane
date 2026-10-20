#!/usr/bin/env python3
"""tgview.py <png> — show one picture in this terminal (Kitty graphics, as paints does), fitted to the pane;
any key or q closes. The pane opens it in a herdr split next to Claude."""
import base64, os, struct, sys, termios, tty

path = sys.argv[1]
raw = open(path, "rb").read()
pw, ph = struct.unpack(">II", raw[16:24])
sz = os.get_terminal_size()
cols, rows = sz.columns, sz.lines - 2

# fit by aspect: a cell is about 1:2, so the picture's columns:rows ratio is (pw/ph)*2
c = min(cols, int(rows * 2 * pw / ph)); r = max(1, int(c * ph / pw / 2))
data = base64.standard_b64encode(raw).decode()
ch = [data[i:i + 4096] for i in range(0, len(data), 4096)]
out = sys.stdout
out.write("\x1b[?1049h\x1b[2J\x1b[?25l\x1b_Ga=d,d=a,q=2\x1b\\\x1b[1;1H")
out.write("".join(f"\x1b_G{'a=T,f=100,c=%d,r=%d,C=1,q=2,' % (c, r) if i == 0 else ''}m={1 if i < len(ch) - 1 else 0};{p}\x1b\\" for i, p in enumerate(ch)))
out.write(f"\x1b[{r + 2};1H\x1b[2m{os.path.basename(path)}  ·  any key — close\x1b[0m")
out.flush()
fd = sys.stdin.fileno(); old = termios.tcgetattr(fd)
try:
    tty.setraw(fd); sys.stdin.read(1)
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
    out.write("\x1b_Ga=d,d=a,q=2\x1b\\\x1b[?25h\x1b[?1049l"); out.flush()
