#!/usr/bin/env python3
"""
Relógio de Timers Sequenciais com Buffer Geral
=============================================

- Defina N timers (ex.: Timer 1 = 20 min, Timer 2 = 10 min, Timer 3 = 15 min)
  e um Buffer Geral (ex.: 30 min).
- Ao dar Play, os timers são consumidos em sequência.
- Quando um timer chega a zero e você ainda não avançou, o tempo excedente
  passa a ser descontado do Buffer Geral (overtime).
- Clique em "Próximo" (ou tecla N) para ir ao timer seguinte.
- Opcional: a sobra de um timer encerrado antes do tempo pode voltar ao buffer.

Atalhos: Espaço = Play/Pausar · N = Próximo · R = Reiniciar

Requer apenas Python 3.8+ (Tkinter já vem com o Python).
Execute:  python relogio_timers.py
"""

import math
import time
import tkinter as tk
from datetime import datetime, timedelta
from tkinter import messagebox

# --------------------------------------------------------------------------- #
#  Paleta
# --------------------------------------------------------------------------- #
BG = "#0f172a"
PANEL = "#1e293b"
PANEL2 = "#273449"
FG = "#e2e8f0"
MUTED = "#94a3b8"
GREEN = "#22c55e"
AMBER = "#f59e0b"
ORANGE = "#f97316"
RED = "#ef4444"
BLUE = "#3b82f6"
GRAY = "#475569"
PALETTE = [BLUE, "#14b8a6", "#a855f7", "#ec4899", "#eab308", "#06b6d4", "#84cc16", "#f472b6"]
FONT = "Helvetica"


def blend(c1, c2, t):
    """Mistura duas cores hex. t=0 -> c1, t=1 -> c2."""
    a = [int(c1[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(c2[i:i + 2], 16) for i in (1, 3, 5)]
    return "#%02x%02x%02x" % tuple(int(a[k] + (b[k] - a[k]) * t) for k in range(3))


def fmt(sec):
    sec = max(0, int(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def ceil_s(x):
    return int(math.ceil(x - 1e-6))


def parse_duration(text, allow_zero=False):
    """Aceita '20' (min), '7.5' / '7,5' (min), '12:30' (mm:ss) ou '1:05:00' (h:mm:ss)."""
    t = text.strip().replace(",", ".")
    if not t:
        raise ValueError
    if ":" in t:
        parts = [float(p) for p in t.split(":")]
        if len(parts) == 2:
            sec = parts[0] * 60 + parts[1]
        elif len(parts) == 3:
            sec = parts[0] * 3600 + parts[1] * 60 + parts[2]
        else:
            raise ValueError
    else:
        sec = float(t) * 60
    if sec < 0 or (sec == 0 and not allow_zero):
        raise ValueError
    return sec


def color_for(frac):
    if frac > 0.5:
        return GREEN
    if frac > 0.2:
        return AMBER
    return ORANGE


# --------------------------------------------------------------------------- #
#  Modelo
# --------------------------------------------------------------------------- #
class Timer:
    def __init__(self, name, duration):
        self.name = name
        self.duration = duration
        self.elapsed = 0.0
        self.done = False

    @property
    def remaining(self):
        return max(0.0, self.duration - self.elapsed)

    @property
    def overtime(self):
        return max(0.0, self.elapsed - self.duration)


class Session:
    def __init__(self, items, buffer_sec, giveback):
        self.timers = [Timer(n, d) for n, d in items]
        self.buffer = buffer_sec
        self.giveback = giveback
        self.index = 0
        self.running = False
        self.started = False
        self.finished = False
        self._last = 0.0

    def current(self):
        return None if self.finished else self.timers[self.index]

    def credit(self):
        if not self.giveback:
            return 0.0
        return sum(t.remaining for t in self.timers if t.done)

    def used(self):
        return sum(t.overtime for t in self.timers)

    def buffer_capacity(self):
        return self.buffer + self.credit()

    def buffer_left(self):
        return self.buffer_capacity() - self.used()

    def planned_remaining(self):
        return sum(t.remaining for t in self.timers if not t.done)

    def total_elapsed(self):
        return sum(t.elapsed for t in self.timers)

    def update(self):
        if self.running and not self.finished:
            now = time.monotonic()
            self.current().elapsed += now - self._last
            self._last = now

    def play(self):
        if self.finished:
            return
        self.running = True
        self.started = True
        self._last = time.monotonic()

    def pause(self):
        self.update()
        self.running = False

    def next(self):
        if self.finished:
            return
        self.update()
        self.current().done = True
        self.index += 1
        if self.index >= len(self.timers):
            self.finished = True
            self.running = False
        else:
            self._last = time.monotonic()


# --------------------------------------------------------------------------- #
#  Widgets auxiliares
# --------------------------------------------------------------------------- #
class FlatButton(tk.Label):
    """Botão plano com cor (funciona igual em Windows, Linux e macOS)."""

    def __init__(self, master, text, command, bg, font=(FONT, 13, "bold"), padx=18, pady=10):
        super().__init__(master, text=text, bg=bg, fg="white", font=font,
                         padx=padx, pady=pady, cursor="hand2")
        self._bg = bg
        self.command = command
        self.enabled = True
        self.bind("<Enter>", lambda e: self.enabled and self.config(bg=blend(self._bg, "#ffffff", 0.15)))
        self.bind("<Leave>", lambda e: self.config(bg=self._bg if self.enabled else GRAY))
        self.bind("<Button-1>", lambda e: self.enabled and self.command())

    def set_style(self, text=None, bg=None):
        if bg:
            self._bg = bg
        self.config(text=text or self.cget("text"), bg=self._bg if self.enabled else GRAY)

    def set_enabled(self, on):
        self.enabled = on
        self.config(bg=self._bg if on else GRAY, fg="white" if on else MUTED,
                    cursor="hand2" if on else "arrow")


def round_rect(c, x0, y0, x1, y1, r=8, **kw):
    if x1 - x0 < 2 * r:
        r = max(0, (x1 - x0) / 2)
    pts = [x0 + r, y0, x1 - r, y0, x1, y0, x1, y0 + r, x1, y1 - r, x1, y1,
           x1 - r, y1, x0 + r, y1, x0, y1, x0, y1 - r, x0, y0 + r, x0, y0]
    return c.create_polygon(pts, smooth=True, **kw)


# --------------------------------------------------------------------------- #
#  Aplicação
# --------------------------------------------------------------------------- #
class App:
    TICK_MS = 100

    def __init__(self, root):
        self.root = root
        root.title("⏱ Timers Sequenciais + Buffer")
        root.configure(bg=BG)
        root.geometry("1240x800")
        root.minsize(1060, 720)

        self.rows = []
        self.session = None
        self.buffer_var = tk.StringVar(value="30")
        self.giveback_var = tk.BooleanVar(value=False)
        self._alerted = set()
        self._alerted_buffer = False
        self._flash_until = 0.0
        self._toast_until = 0.0

        self._build_left()
        self._build_right()

        for name, mins in [("Timer 1", "20"), ("Timer 2", "10"), ("Timer 3", "15")]:
            self.add_row(name, mins)

        root.bind_all("<KeyPress>", self._on_key)
        self.tick()

    # ------------------------------------------------------------------ UI --
    def _build_left(self):
        left = tk.Frame(self.root, bg=PANEL, width=370)
        left.pack(side="left", fill="y")
        left.pack_propagate(False)

        tk.Label(left, text="⚙  Configuração", bg=PANEL, fg=FG,
                 font=(FONT, 18, "bold")).pack(anchor="w", padx=20, pady=(20, 2))
        tk.Label(left, text="Duração em minutos  (ex.: 20 · 7.5 · 12:30)", bg=PANEL, fg=MUTED,
                 font=(FONT, 10)).pack(anchor="w", padx=20)

        # parte de baixo (fixa)
        bottom = tk.Frame(left, bg=PANEL)
        bottom.pack(side="bottom", fill="x", padx=20, pady=(0, 18))

        self.add_btn = FlatButton(bottom, "＋  Adicionar timer", lambda: self.add_row(), bg=BLUE,
                                  font=(FONT, 12, "bold"), pady=8)
        self.add_btn.pack(fill="x", pady=(4, 14))

        bf = tk.Frame(bottom, bg=PANEL2, padx=12, pady=10)
        bf.pack(fill="x")
        tk.Label(bf, text="◆  Buffer geral (min)", bg=PANEL2, fg=AMBER,
                 font=(FONT, 12, "bold")).pack(side="left")
        self.buffer_entry = tk.Entry(bf, textvariable=self.buffer_var, width=7, justify="center",
                                     bg=BG, fg=FG, insertbackground=FG, relief="flat",
                                     font=(FONT, 13, "bold"), disabledbackground=PANEL,
                                     disabledforeground=MUTED)
        self.buffer_entry.pack(side="right", ipady=4)
        self.buffer_var.trace_add("write", lambda *a: self.update_summary())

        self.giveback_chk = tk.Checkbutton(
            bottom, text="Sobra de um timer encerrado antes do tempo volta para o buffer",
            variable=self.giveback_var, bg=PANEL, fg=FG, selectcolor=PANEL2,
            activebackground=PANEL, activeforeground=FG, wraplength=300, justify="left",
            font=(FONT, 10), anchor="w", highlightthickness=0, bd=0)
        self.giveback_chk.pack(fill="x", pady=(10, 6))

        self.summary_lbl = tk.Label(bottom, text="", bg=PANEL, fg=MUTED, font=(FONT, 11),
                                    justify="left", anchor="w")
        self.summary_lbl.pack(fill="x", pady=(6, 8))

        tk.Label(bottom, text="Atalhos:  Espaço = Play/Pausar  ·  N = Próximo  ·  R = Reiniciar",
                 bg=PANEL, fg=GRAY, font=(FONT, 9), wraplength=320, justify="left",
                 anchor="w").pack(fill="x")

        # lista rolável de timers
        wrap = tk.Frame(left, bg=PANEL)
        wrap.pack(fill="both", expand=True, padx=12, pady=10)
        self.rows_canvas = tk.Canvas(wrap, bg=PANEL, highlightthickness=0)
        sb = tk.Scrollbar(wrap, orient="vertical", command=self.rows_canvas.yview)
        self.rows_frame = tk.Frame(self.rows_canvas, bg=PANEL)
        self.rows_frame.bind("<Configure>", lambda e: self.rows_canvas.configure(
            scrollregion=self.rows_canvas.bbox("all")))
        self._rows_win = self.rows_canvas.create_window((0, 0), window=self.rows_frame, anchor="nw")
        self.rows_canvas.bind("<Configure>", lambda e: self.rows_canvas.itemconfigure(
            self._rows_win, width=e.width))
        self.rows_canvas.configure(yscrollcommand=sb.set)
        self.rows_canvas.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

    def _build_right(self):
        right = tk.Frame(self.root, bg=BG)
        right.pack(side="left", fill="both", expand=True, padx=22, pady=16)
        right.bind("<Button-1>", lambda e: self.root.focus_set())

        top = tk.Frame(right, bg=BG)
        top.pack(fill="x")

        self.ring = tk.Canvas(top, width=370, height=370, bg=BG, highlightthickness=0)
        self.ring.pack(side="left")
        self.ring.bind("<Button-1>", lambda e: self.root.focus_set())

        info = tk.Frame(top, bg=BG)
        info.pack(side="left", fill="both", expand=True, padx=(24, 0))

        self.lbl_step = tk.Label(info, text="", bg=BG, fg=MUTED, font=(FONT, 12, "bold"), anchor="w")
        self.lbl_step.pack(fill="x", pady=(18, 0))
        self.lbl_name = tk.Label(info, text="", bg=BG, fg=FG, font=(FONT, 30, "bold"),
                                 anchor="w", justify="left", wraplength=520)
        self.lbl_name.pack(fill="x")
        self.lbl_state = tk.Label(info, text="", bg=BG, fg=MUTED, font=(FONT, 14, "bold"), anchor="w")
        self.lbl_state.pack(fill="x", pady=(6, 0))
        self.lbl_next = tk.Label(info, text="", bg=BG, fg=MUTED, font=(FONT, 12), anchor="w")
        self.lbl_next.pack(fill="x", pady=(2, 14))

        cards = tk.Frame(info, bg=BG)
        cards.pack(fill="x")
        self.card_elapsed = self._card(cards, "DECORRIDO")
        self.card_end = self._card(cards, "TÉRMINO PREVISTO")
        self.card_limit = self._card(cards, "LIMITE C/ BUFFER")

        ctrl = tk.Frame(info, bg=BG)
        ctrl.pack(fill="x", pady=(18, 0))
        self.play_btn = FlatButton(ctrl, "▶  Play", self.toggle_play, bg=GREEN, font=(FONT, 14, "bold"),
                                   padx=8, pady=12)
        self.play_btn.pack(side="left", fill="x", expand=True)
        self.next_btn = FlatButton(ctrl, "⏭  Próximo", self.next_timer, bg=BLUE, font=(FONT, 14, "bold"),
                                   padx=8, pady=12)
        self.next_btn.pack(side="left", fill="x", expand=True, padx=8)
        self.reset_btn = FlatButton(ctrl, "⟲  Reiniciar", self.reset, bg="#64748b",
                                    font=(FONT, 14, "bold"), padx=8, pady=12)
        self.reset_btn.pack(side="left", fill="x", expand=True)

        self.toast = tk.Label(info, text="", bg=BG, fg=RED, font=(FONT, 13, "bold"), anchor="w")
        self.toast.pack(fill="x", pady=(10, 0))

        self.buf_c = tk.Canvas(right, height=74, bg=BG, highlightthickness=0)
        self.buf_c.pack(fill="x", pady=(14, 4))
        self.tl_c = tk.Canvas(right, height=104, bg=BG, highlightthickness=0)
        self.tl_c.pack(fill="x", pady=(4, 6))
        self.st_c = tk.Canvas(right, bg=BG, highlightthickness=0)
        self.st_c.pack(fill="both", expand=True)

    def _card(self, parent, title):
        f = tk.Frame(parent, bg=PANEL, padx=14, pady=10)
        f.pack(side="left", padx=(0, 10), fill="x", expand=True)
        tk.Label(f, text=title, bg=PANEL, fg=MUTED, font=(FONT, 9, "bold"), anchor="w").pack(fill="x")
        v = tk.Label(f, text="--", bg=PANEL, fg=FG, font=(FONT, 18, "bold"), anchor="w")
        v.pack(fill="x")
        return v

    # ----------------------------------------------------- config rows --
    def add_row(self, name=None, minutes="10"):
        if self.session is not None:
            return
        i = len(self.rows)
        f = tk.Frame(self.rows_frame, bg=PANEL2, padx=8, pady=7)
        f.pack(fill="x", pady=4)

        dot = tk.Canvas(f, width=14, height=14, bg=PANEL2, highlightthickness=0)
        dot.pack(side="left")
        nv = tk.StringVar(value=name or f"Timer {i + 1}")
        dv = tk.StringVar(value=minutes)
        ent_kw = dict(bg=BG, fg=FG, insertbackground=FG, relief="flat", font=(FONT, 12),
                      disabledbackground=PANEL, disabledforeground=MUTED)
        ne = tk.Entry(f, textvariable=nv, width=12, **ent_kw)
        ne.pack(side="left", padx=6, fill="x", expand=True, ipady=4)
        de = tk.Entry(f, textvariable=dv, width=6, justify="center", **ent_kw)
        de.pack(side="left", ipady=4)

        row = {"frame": f, "dot": dot, "name": nv, "dur": dv, "entries": [ne, de], "dur_entry": de}
        icons = tk.Frame(f, bg=PANEL2)
        icons.pack(side="left", padx=(6, 0))
        for txt, cmd, col in [("▲", lambda r=row: self.move_row(r, -1), MUTED),
                              ("▼", lambda r=row: self.move_row(r, 1), MUTED),
                              ("✕", lambda r=row: self.remove_row(r), RED)]:
            b = tk.Label(icons, text=txt, bg=PANEL2, fg=col, font=(FONT, 11, "bold"), cursor="hand2", padx=3)
            b.pack(side="left")
            b.bind("<Button-1>", lambda e, c=cmd: c())

        nv.trace_add("write", lambda *a: self.update_summary())
        dv.trace_add("write", lambda *a: self.update_summary())
        self.rows.append(row)
        self.refresh_rows()
        self.rows_canvas.after(50, lambda: self.rows_canvas.yview_moveto(1.0))

    def remove_row(self, row):
        if self.session is not None or len(self.rows) <= 1:
            return
        row["frame"].destroy()
        self.rows.remove(row)
        self.refresh_rows()

    def move_row(self, row, d):
        if self.session is not None:
            return
        i = self.rows.index(row)
        j = i + d
        if 0 <= j < len(self.rows):
            self.rows[i], self.rows[j] = self.rows[j], self.rows[i]
            self.refresh_rows()

    def refresh_rows(self):
        for r in self.rows:
            r["frame"].pack_forget()
        for i, r in enumerate(self.rows):
            r["frame"].pack(fill="x", pady=4)
            r["dot"].delete("all")
            r["dot"].create_oval(2, 2, 13, 13, fill=PALETTE[i % len(PALETTE)], outline="")
        self.update_summary()

    def read_config(self):
        items = []
        for i, r in enumerate(self.rows):
            try:
                d = parse_duration(r["dur"].get())
                r["dur_entry"].config(bg=BG)
            except ValueError:
                r["dur_entry"].config(bg="#7f1d1d")
                raise ValueError(f"Duração inválida no timer {i + 1}.")
            items.append((r["name"].get().strip() or f"Timer {i + 1}", d))
        try:
            buf = parse_duration(self.buffer_var.get(), allow_zero=True)
            self.buffer_entry.config(bg=BG)
        except ValueError:
            self.buffer_entry.config(bg="#7f1d1d")
            raise ValueError("Duração inválida no buffer.")
        return items, buf

    def update_summary(self):
        try:
            items, buf = self.read_config()
        except ValueError as e:
            self.summary_lbl.config(text=f"⚠ {e}", fg=RED)
            return
        total = sum(d for _, d in items)
        self.summary_lbl.config(
            fg=MUTED,
            text=f"{len(items)} timers · planejado {fmt(total)}\n"
                 f"com buffer: {fmt(total + buf)}")

    def set_locked(self, on):
        st = "disabled" if on else "normal"
        for r in self.rows:
            for e in r["entries"]:
                e.config(state=st)
        self.buffer_entry.config(state=st)
        self.giveback_chk.config(state=st)
        self.add_btn.set_enabled(not on)

    # -------------------------------------------------------- controls --
    def _on_key(self, e):
        if isinstance(self.root.focus_get(), tk.Entry):
            return
        k = e.keysym.lower()
        if k == "space":
            self.toggle_play()
        elif k == "n":
            self.next_timer()
        elif k == "r":
            self.reset()

    def toggle_play(self):
        if self.session is None:
            try:
                items, buf = self.read_config()
            except ValueError as err:
                messagebox.showerror("Configuração inválida", str(err))
                return
            self.session = Session(items, buf, self.giveback_var.get())
            self._alerted.clear()
            self._alerted_buffer = False
            self.set_locked(True)
            self.root.focus_set()
        s = self.session
        if s.finished:
            return
        if s.running:
            s.pause()
        else:
            s.play()

    def next_timer(self):
        s = self.session
        if s is None or not s.started or s.finished:
            return
        s.next()
        if s.finished:
            self.root.bell()
            self.show_toast("✔ Sessão concluída!", GREEN)

    def reset(self):
        s = self.session
        if s is None:
            return
        if s.started and not s.finished:
            if not messagebox.askyesno("Reiniciar", "Interromper a sessão atual e reiniciar?"):
                return
        self.session = None
        self.set_locked(False)
        self.toast.config(text="")

    def show_toast(self, text, color=RED, secs=4):
        self.toast.config(text=text, fg=color)
        self._toast_until = time.monotonic() + secs

    # ------------------------------------------------------------ loop --
    def view_session(self):
        if self.session is not None:
            return self.session
        try:
            items, buf = self.read_config()
        except ValueError:
            return None
        return Session(items, buf, self.giveback_var.get())

    def tick(self):
        try:
            s = self.session
            if s is not None:
                s.update()
                self._check_alerts(s)
            v = self.view_session()
            self.draw_ring(v)
            self.update_info(v)
            self.draw_buffer(v)
            self.draw_timeline(v)
            self.draw_status(v)
            if self._toast_until and time.monotonic() > self._toast_until:
                self.toast.config(text="")
                self._toast_until = 0
        finally:
            self.root.after(self.TICK_MS, self.tick)

    def _check_alerts(self, s):
        t = s.current()
        if t is None:
            return
        if t.elapsed >= t.duration and s.index not in self._alerted:
            self._alerted.add(s.index)
            self.root.bell()
            self._flash_until = time.monotonic() + 2
            self.show_toast(f"⏰ {t.name} esgotado — agora consumindo o buffer")
        if s.buffer_left() < 0 and not self._alerted_buffer:
            self._alerted_buffer = True
            self.root.bell()
            self.root.after(250, self.root.bell)
            self._flash_until = time.monotonic() + 3
            self.show_toast("⚠ BUFFER ESGOTADO — você está além do tempo total!", RED, 6)

    # ------------------------------------------------------------ draw --
    def draw_ring(self, s):
        c = self.ring
        c.delete("all")
        W = max(c.winfo_width(), 370)
        H = max(c.winfo_height(), 370)
        cx, cy = W / 2, H / 2
        r = min(W, H) / 2 - 26
        th = 24
        box = (cx - r, cy - r, cx + r, cy + r)
        now = time.monotonic()
        blink = int(now * 2) % 2 == 0
        flash = now < self._flash_until

        if flash and blink:
            c.create_oval(cx - r - 22, cy - r - 22, cx + r + 22, cy + r + 22, fill="#3b1d24", outline="")
        c.create_oval(*box, outline=PANEL2, width=th)

        if s is None:
            c.create_text(cx, cy, text="--:--", fill=MUTED, font=(FONT, 56, "bold"))
            c.create_text(cx, cy + r * 0.34, text="configure os timers", fill=MUTED, font=(FONT, 13))
            return

        if s.finished:
            c.create_arc(*box, start=90, extent=-359.9, style="arc", outline=GREEN, width=th)
            c.create_text(cx, cy - 22, text="✔", fill=GREEN, font=(FONT, 48, "bold"))
            c.create_text(cx, cy + 34, text="CONCLUÍDO", fill=FG, font=(FONT, 22, "bold"))
            c.create_text(cx, cy + r * 0.48, text=f"total {fmt(s.total_elapsed())}",
                          fill=MUTED, font=(FONT, 13))
            return

        t = s.current()
        idx_color = PALETTE[s.index % len(PALETTE)]

        if t.overtime > 0:
            bl = s.buffer_left()
            cap = s.buffer_capacity()
            c.create_oval(*box, outline="#3b1d24", width=th)
            frac = max(0.0, bl) / cap if cap > 0 else 0.0
            if frac > 0:
                c.create_arc(*box, start=90, extent=-359.9 * frac, style="arc",
                             outline=RED if (blink or not s.running) else ORANGE, width=th)
            main = "+" + fmt(t.overtime)
            color = RED
            sub = "consumindo buffer" if bl >= 0 else "BUFFER ESTOURADO"
            sub_color = AMBER if bl >= 0 else RED
        else:
            frac = t.remaining / t.duration
            color = color_for(frac)
            if frac > 0:
                c.create_arc(*box, start=90, extent=-359.9 * frac, style="arc", outline=color, width=th)
                ang = math.radians(90 - 360 * frac)
                kx, ky = cx + r * math.cos(ang), cy - r * math.sin(ang)
                c.create_oval(kx - th / 2 - 3, ky - th / 2 - 3, kx + th / 2 + 3, ky + th / 2 + 3,
                              fill=FG, outline=BG, width=3)
            main = fmt(ceil_s(t.remaining))
            sub = f"de {fmt(t.duration)}"
            sub_color = MUTED

        size = int(r * (0.36 if len(main) <= 6 else 0.27))
        c.create_text(cx, cy - 6, text=main, fill=color, font=(FONT, size, "bold"))
        c.create_text(cx, cy + r * 0.36, text=sub, fill=sub_color, font=(FONT, 13, "bold"))
        c.create_oval(cx - 6, cy - r * 0.42 - 6, cx + 6, cy - r * 0.42 + 6, fill=idx_color, outline="")
        if not s.running:
            label = "⏸ PAUSADO" if s.started else "PRONTO"
            c.create_text(cx, cy - r * 0.58, text=label, fill=AMBER, font=(FONT, 12, "bold"))

    def update_info(self, s):
        if s is None:
            self.lbl_step.config(text="CONFIGURAÇÃO INVÁLIDA")
            self.lbl_name.config(text="—", fg=FG)
            self.lbl_state.config(text="Corrija os campos à esquerda", fg=RED)
            self.lbl_next.config(text="")
            for card in (self.card_elapsed, self.card_end, self.card_limit):
                card.config(text="--", fg=FG)
            self.play_btn.set_enabled(False)
            self.next_btn.set_enabled(False)
            self.reset_btn.set_enabled(False)
            return

        n = len(s.timers)
        now_dt = datetime.now()
        self.card_elapsed.config(text=fmt(s.total_elapsed()), fg=FG)

        if s.finished:
            self.lbl_step.config(text="SESSÃO CONCLUÍDA")
            self.lbl_name.config(text="Todos os timers concluídos", fg=GREEN)
            bl = s.buffer_left()
            if bl >= 0:
                self.lbl_state.config(text=f"Buffer restante: {fmt(bl)}", fg=GREEN)
            else:
                self.lbl_state.config(text=f"Excedeu o total em {fmt(-bl)}", fg=RED)
            self.lbl_next.config(text="Clique em Reiniciar para uma nova sessão")
            self.card_end.config(text="—", fg=FG)
            self.card_limit.config(text="—", fg=FG)
            self.play_btn.set_style("▶  Play", GREEN)
            self.play_btn.set_enabled(False)
            self.next_btn.set_enabled(False)
            self.reset_btn.set_enabled(True)
            return

        t = s.current()
        self.lbl_step.config(text=f"TIMER {s.index + 1} DE {n}")
        self.lbl_name.config(text=t.name, fg=PALETTE[s.index % len(PALETTE)])

        bl = s.buffer_left()
        if not s.started:
            self.lbl_state.config(text="Pressione ▶ Play para começar", fg=MUTED)
        elif t.overtime > 0 and bl < 0:
            self.lbl_state.config(text=f"⚠ Buffer estourado em {fmt(-bl)}", fg=RED)
        elif t.overtime > 0:
            self.lbl_state.config(text="⏰ Tempo esgotado — consumindo o buffer", fg=RED)
        elif s.running:
            self.lbl_state.config(text="▶ Em andamento", fg=GREEN)
        else:
            self.lbl_state.config(text="⏸ Pausado", fg=AMBER)

        if s.index + 1 < n:
            nt = s.timers[s.index + 1]
            self.lbl_next.config(text=f"A seguir:  {nt.name}  ({fmt(nt.duration)})")
        else:
            self.lbl_next.config(text="Este é o último timer")

        rem = s.planned_remaining()
        end = now_dt + timedelta(seconds=rem)
        self.card_end.config(text=end.strftime("%H:%M"), fg=FG)
        if bl >= 0:
            self.card_limit.config(text=(end + timedelta(seconds=bl)).strftime("%H:%M"), fg=AMBER)
        else:
            self.card_limit.config(text="estourado", fg=RED)

        # botões
        if s.running:
            self.play_btn.set_style("⏸  Pausar", AMBER)
        else:
            self.play_btn.set_style("▶  Retomar" if s.started else "▶  Play", GREEN)
        self.play_btn.set_enabled(True)
        self.next_btn.set_style("✔  Finalizar" if s.index == n - 1 else "⏭  Próximo")
        self.next_btn.set_enabled(s.started)
        self.reset_btn.set_enabled(s.started or self.session is not None)

    def draw_buffer(self, s):
        c = self.buf_c
        c.delete("all")
        W = c.winfo_width()
        H = c.winfo_height()
        if W < 50 or s is None:
            return
        bl = s.buffer_left()
        cap = s.buffer_capacity()
        t = s.current()
        consuming = t is not None and t.overtime > 0 and s.running

        c.create_text(0, 12, anchor="w", text="◆  BUFFER GERAL", fill=AMBER, font=(FONT, 12, "bold"))
        if bl >= 0:
            txt = f"{fmt(ceil_s(bl))} restantes de {fmt(cap)}"
            if s.giveback and s.credit() > 0:
                txt += f"   (+{fmt(s.credit())} de sobras)"
            col = FG
        else:
            txt = f"ESTOURADO em {fmt(-bl)}"
            col = RED
        c.create_text(W, 12, anchor="e", text=txt, fill=col, font=(FONT, 12, "bold"))

        y0, y1 = 28, H - 10
        round_rect(c, 0, y0, W, y1, 10, fill=PANEL2, outline="")
        if bl < 0:
            round_rect(c, 0, y0, W, y1, 10, fill=RED, outline="")
            c.create_rectangle(0, y0, W, y1, fill=BG, outline="", stipple="gray25")
            c.create_text(W / 2, (y0 + y1) / 2, text="SEM BUFFER", fill="white", font=(FONT, 13, "bold"))
        elif cap > 0:
            frac = bl / cap
            fcol = color_for(frac)
            if consuming and int(time.monotonic() * 2) % 2 == 0:
                fcol = blend(fcol, "#ffffff", 0.25)
            x = W * frac
            if x > 2:
                round_rect(c, 0, y0, x, y1, 10, fill=fcol, outline="")
            c.create_text(12, (y0 + y1) / 2, anchor="w", text=f"{frac * 100:.0f}%",
                          fill="white" if x > 60 else FG, font=(FONT, 12, "bold"))
            if consuming:
                c.create_text(min(max(x, 70), W - 70), (y0 + y1) / 2, text="◀ consumindo",
                              fill="white", font=(FONT, 11, "bold"), anchor="e" if x > 140 else "w")
        else:
            c.create_text(W / 2, (y0 + y1) / 2, text="sem buffer configurado", fill=MUTED, font=(FONT, 11))

    def draw_timeline(self, s):
        c = self.tl_c
        c.delete("all")
        W = c.winfo_width()
        if W < 50 or s is None:
            return
        c.create_text(0, 10, anchor="w", text="LINHA DO TEMPO", fill=MUTED, font=(FONT, 11, "bold"))
        total = sum(t.duration for t in s.timers) + s.buffer
        if total <= 0:
            return
        gap = 4
        segs = len(s.timers) + (1 if s.buffer > 0 else 0)
        usable = W - gap * (segs - 1)
        y0, y1 = 34, 66
        x = 0.0
        marker_x = None
        for i, t in enumerate(s.timers):
            w = usable * t.duration / total
            col = PALETTE[i % len(PALETTE)]
            is_cur = (not s.finished and i == s.index)
            round_rect(c, x, y0, x + w, y1, 6, fill=blend(col, BG, 0.75), outline="")
            fill_w = w * min(t.elapsed, t.duration) / t.duration
            if fill_w > 1:
                round_rect(c, x, y0, x + fill_w, y1, 6, fill=col if not t.done else blend(col, BG, 0.3),
                           outline="")
            if t.done:
                mark = "✔" if t.overtime == 0 else "✔+"
                c.create_text(x + w / 2, (y0 + y1) / 2, text=mark, fill="white", font=(FONT, 12, "bold"))
            if is_cur:
                round_rect(c, x - 2, y0 - 2, x + w + 2, y1 + 2, 7, fill="", outline=FG, width=2)
                marker_x = x + fill_w
            maxch = max(1, int(w / 7.5))
            label = t.name if len(t.name) <= maxch else t.name[:max(1, maxch - 1)] + "…"
            c.create_text(x + w / 2, y1 + 11, text=label, fill=FG if is_cur else MUTED,
                          font=(FONT, 10, "bold" if is_cur else "normal"))
            if w > 50:
                c.create_text(x + w / 2, y1 + 26, text=fmt(t.duration), fill=GRAY, font=(FONT, 9))
            x += w + gap

        if s.buffer > 0:
            w = usable * s.buffer / total
            round_rect(c, x, y0, x + w, y1, 6, fill=blend(AMBER, BG, 0.8), outline="")
            c.create_rectangle(x, y0, x + w, y1, fill=AMBER, outline="", stipple="gray12")
            used_frac = min(1.0, s.used() / s.buffer)
            if used_frac > 0:
                round_rect(c, x, y0, x + w * used_frac, y1, 6, fill=RED, outline="")
            c.create_text(x + w / 2, y1 + 11, text="Buffer", fill=AMBER, font=(FONT, 10, "bold"))
            if w > 50:
                c.create_text(x + w / 2, y1 + 26, text=fmt(s.buffer), fill=GRAY, font=(FONT, 9))
            t = s.current()
            if t is not None and t.overtime > 0:
                marker_x = x + w * used_frac

        if marker_x is not None and s.started:
            t = s.current()
            mcol = RED if (t and t.overtime > 0) else FG
            c.create_polygon(marker_x - 7, y0 - 12, marker_x + 7, y0 - 12, marker_x, y0 - 3,
                             fill=mcol, outline="")
            c.create_line(marker_x, y0 - 3, marker_x, y1, fill=mcol, width=2)

    def draw_status(self, s):
        c = self.st_c
        c.delete("all")
        W = c.winfo_width()
        H = c.winfo_height()
        if W < 50 or s is None:
            return
        cols = [10, 56, 0.46 * W, 0.62 * W, 0.80 * W]
        heads = ["", "TIMER", "PLANEJADO", "REAL", "SALDO"]
        for x, h in zip(cols, heads):
            c.create_text(x, 12, anchor="w", text=h, fill=MUTED, font=(FONT, 10, "bold"))
        n = len(s.timers)
        rh = max(22, min(38, (H - 28) / max(n, 1)))
        y = 26
        for i, t in enumerate(s.timers):
            cur = not s.finished and i == s.index
            if cur:
                round_rect(c, 0, y, W, y + rh - 4, 8, fill=PANEL2, outline="")
            elif i % 2 == 0:
                round_rect(c, 0, y, W, y + rh - 4, 8, fill=blend(PANEL, BG, 0.5), outline="")
            cy = y + (rh - 4) / 2
            if t.done:
                icon, icol = "✔", GREEN if t.overtime == 0 else ORANGE
            elif cur:
                icon, icol = ("▶" if s.running else "⏸"), (GREEN if s.running else AMBER)
            else:
                icon, icol = "•", GRAY
            c.create_text(cols[0], cy, anchor="w", text=icon, fill=icol, font=(FONT, 12, "bold"))
            col = PALETTE[i % len(PALETTE)]
            c.create_oval(cols[1] - 20, cy - 5, cols[1] - 10, cy + 5, fill=col, outline="")
            c.create_text(cols[1], cy, anchor="w", text=t.name, fill=FG if (cur or t.done) else MUTED,
                          font=(FONT, 12, "bold" if cur else "normal"))
            c.create_text(cols[2], cy, anchor="w", text=fmt(t.duration), fill=MUTED, font=(FONT, 12))
            real = fmt(t.elapsed) if (t.done or cur and s.started) else "—"
            c.create_text(cols[3], cy, anchor="w", text=real, fill=FG, font=(FONT, 12))
            if t.overtime > 0:
                saldo, scol = f"+{fmt(t.overtime)} do buffer", RED
            elif t.done and t.remaining >= 1:
                extra = " → buffer" if s.giveback else ""
                saldo, scol = f"−{fmt(t.remaining)} sobrou{extra}", GREEN
            elif t.done:
                saldo, scol = "no tempo", GREEN
            else:
                saldo, scol = "—", GRAY
            c.create_text(cols[4], cy, anchor="w", text=saldo, fill=scol, font=(FONT, 12, "bold"))
            y += rh


def main():
    try:  # nitidez em telas de alta resolução no Windows
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
