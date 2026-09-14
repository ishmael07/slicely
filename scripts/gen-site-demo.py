"""Generate the landing page's hero demo: the markup between the demo markers in
site/index.html and the timeline CSS between the markers in site/styles.css.

The demo is one continuous conversation with three exchanges, replayed as a
single CSS-only loop. Every element's keyframes are computed here from one
schedule (seconds), so the pieces can never drift apart. Run after editing:

    python3 scripts/gen-site-demo.py
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "site"
LOOP = 47.0          # seconds per cycle
SCENE = 15.0         # seconds per exchange
FADE_END = 1.0       # the transcript fades out over the last second

# ---------------------------------------------------------------- content ----
SCENES = [
    dict(
        key="a",
        typed="Find me a phone stand I can print today",
        user='<span>Find me a phone stand I can print today</span>',
        act_a="Searching 8 sources…", act_b="Found 12 models", steps="3 steps",
        content='''<div class="m-cards e-a-content">
              <div class="m-card e-a-card1"><img class="m-thumb" src="img/stand-minimal.png" width="190" height="120" alt="" /><div class="m-meta"><b>Minimal Phone Stand</b><span class="m-sub"><span>Printables</span><span>by tomasp</span></span><span class="m-lic">CC BY</span><span class="m-actions"><i class="m-btn primary">Import</i><i class="m-btn">View</i></span></div></div>
              <div class="m-card e-a-card2"><img class="m-thumb" src="img/stand-adjustable.png" width="190" height="120" alt="" /><div class="m-meta"><b>Adjustable Stand v2</b><span class="m-sub"><span>MakerWorld</span><span>by lea.k</span></span><span class="m-lic">CC BY-NC</span><span class="m-actions"><i class="m-btn primary">Import</i><i class="m-btn">View</i></span></div></div>
              <div class="m-card e-a-card3"><img class="m-thumb" src="img/stand-lowpoly.png" width="190" height="120" alt="" /><div class="m-meta"><b>Low-poly Phone Dock</b><span class="m-sub"><span>Thingiverse</span><span>by jm3d</span></span><span class="m-lic">CC BY-SA</span><span class="m-actions"><i class="m-btn primary">Import</i><i class="m-btn">View</i></span></div></div>
            </div>''',
        content_max=250,
        bot="Flat base, no overhangs, so no supports. Slicing the Printables one for your Ender&nbsp;3 in PLA at 0.2&nbsp;mm.",
        panel_title="Slice result",
        rows=[("Print time", "1h 42m", 78), ("Filament", "18.4 g", 46), ("Layers", "210", 62)],
        actions=["Send to Ender 3", "Download G-code"],
        toast="Sent to Ender 3 ✓",
    ),
    dict(
        key="b",
        typed="Slice this for strength, PETG, my Ender 3",
        user='<span><i class="m-chip">bracket.stl · 1.2 MB</i>Slice this for strength, PETG, my Ender 3</span>',
        act_a="Reading bracket.stl…", act_b="Checked 6 orientations", steps="2 steps",
        content='''<div class="m-panel e-b-content"><div class="m-panel-in">
              <div class="m-panel-h"><i aria-hidden="true">✦</i>bracket.stl</div>
              <div class="m-metrics">
                <div class="m-metric"><span>Size</span><b>48 × 22 × 30 mm</b></div>
                <div class="m-metric"><span>Best pose</span><b>on its back</b></div>
                <div class="m-metric"><span>Overhang</span><b>0 %</b></div>
              </div>
            </div></div>''',
        content_max=120,
        bot="On its back is best: nothing overhangs, so no supports. For strength, 5 walls and 40% gyroid infill in PETG at 0.2&nbsp;mm.",
        panel_title="Slice result",
        rows=[("Print time", "2h 58m", 90), ("Filament", "41.2 g", 66), ("Layers", "150", 48)],
        actions=["Send to Ender 3", "Download G-code"],
        toast="Sent to Ender 3 ✓",
    ),
    dict(
        key="c",
        typed="Print every part of this",
        user='<span><i class="m-chip">github.com/…/desk-organizer</i>Print every part of this</span>',
        act_a="Fetching parts from GitHub…", act_b="14 parts, 2 plates", steps="4 steps",
        content='''<div class="m-plates e-c-content">
              <div class="m-plate"><i class="m-dot slicing"></i><span><b>Plate 1</b> · 8 parts · slicing</span></div>
              <div class="m-plate"><i class="m-dot"></i><span><b>Plate 2</b> · 6 parts · queued</span></div>
            </div>''',
        content_max=110,
        bot="Two plates, grouped so each needs one filament. Plate 1 is slicing; plate 2 follows.",
        panel_title="Plate 1 of 2",
        rows=[("Print time", "6h 10m", 86), ("Filament", "92.5 g", 72), ("On plate", "8 parts", 57)],
        actions=["Send to Ender 3", "Download .3mf"],
        toast="Plate 1 sent to Ender 3 ✓",
    ),
]

# ------------------------------------------------------------- schedule ----
# Relative to each exchange's start, in seconds.
T = dict(type_start=0.0, type_len=2.4, user=2.6, act=3.2, found=5.4, content=5.7,
         bot=7.8, bot_caret=1.8, panel=9.8, bars=(10.4, 10.8, 11.2), bar_len=1.7,
         tail=12.4, toast=12.9, toast_len=2.3)

def pct(s):
    return f"{s / LOOP * 100:.2f}%"

def arrive(name, t, max_h, grow=0.55, fade=0.75, lift=12):
    """Grow from the bottom of the transcript, then fade and rise in."""
    return f"""@keyframes {name} {{
  0%, {pct(t)} {{ max-height: 0; margin-top: 0; opacity: 0; transform: translateY({lift}px); overflow: hidden; }}
  {pct(t + 0.05)} {{ opacity: 0; transform: translateY({lift}px); }}
  {pct(t + grow)} {{ max-height: {max_h}px; margin-top: var(--gap); }}
  {pct(t + fade)} {{ opacity: 1; transform: none; overflow: hidden; }}
  {pct(t + fade + 0.05)}, 100% {{ max-height: {max_h}px; margin-top: var(--gap); opacity: 1; transform: none; overflow: visible; }}
}}
"""

def fade_in(name, t0, t1):
    return f"@keyframes {name} {{ 0%, {pct(t0)} {{ opacity: 0; }} {pct(t1)}, 100% {{ opacity: 1; }} }}\n"

def fade_out(name, t0, t1):
    return f"@keyframes {name} {{ 0%, {pct(t0)} {{ opacity: 1; }} {pct(t1)}, 100% {{ opacity: 0; }} }}\n"

def window(name, t0, t1, ramp=0.45, lift=10):
    """Visible only between t0 and t1 (a toast)."""
    return f"""@keyframes {name} {{
  0%, {pct(t0)} {{ opacity: 0; transform: translate(-50%, {lift}px); }}
  {pct(t0 + ramp)}, {pct(t1 - ramp)} {{ opacity: 1; transform: translate(-50%, 0); }}
  {pct(t1)}, 100% {{ opacity: 0; transform: translate(-50%, 0); }}
}}
"""

def typed(name, t0, n_chars, length):
    t1 = t0 + length
    return f"""@keyframes {name} {{
  0%, {pct(t0)} {{ width: 0; opacity: 0; animation-timing-function: steps(1, end); }}
  {pct(t0 + 0.15)} {{ width: 0; opacity: 1; animation-timing-function: steps({n_chars}, end); }}
  {pct(t1)} {{ width: {n_chars}ch; opacity: 1; animation-timing-function: ease; }}
  {pct(t1 + 0.2)} {{ opacity: 1; }}
  {pct(t1 + 0.5)}, 100% {{ width: {n_chars}ch; opacity: 0; }}
}}
"""

def slide(name, t, dur=0.6, shift=18):
    return f"@keyframes {name} {{ 0%, {pct(t)} {{ opacity: 0; transform: translateX({shift}px); }} {pct(t + dur)}, 100% {{ opacity: 1; transform: none; }} }}\n"

def bar(name, t, width, length):
    return f"@keyframes {name} {{ 0%, {pct(t)} {{ width: 0; }} {pct(t + length)}, 100% {{ width: {width}%; }} }}\n"

# --------------------------------------------------------------- build ----
html = []
css_kf = []
css_use = []
css_rm = []

def use(selector, kf, timing="var(--ease)", extra=""):
    css_use.append(f"{selector} {{ animation: {kf} {LOOP}s {timing} infinite{extra}; }}")
    css_rm.append(f"  {selector} {{ animation: {kf} {LOOP}s linear -{SEEK}s infinite paused !important; }}")

# The reduced-motion frame: the last exchange, its toast fully up.
SEEK = round(2 * SCENE + T["toast"] + 1.1, 2)

# empty state + placeholder
css_kf.append(fade_out("d-empty", T["type_len"] - 0.3, T["type_len"] + 0.6))
use(".m-empty", "d-empty")
css_kf.append(f"@keyframes d-fade {{ 0%, {pct(LOOP - FADE_END)} {{ opacity: 1; }} 100% {{ opacity: 0; }} }}\n")
use(".app-msgs", "d-fade", "linear")

ph_parts = ["0%"]
ph = "@keyframes d-ph { "
segs = []
for i, sc in enumerate(SCENES):
    t0 = i * SCENE
    segs.append((t0 + T["type_start"], t0 + T["type_len"] + 0.6))
frames = []
prev = 0.0
for (a, b) in segs:
    frames.append(f"{pct(a)} {{ opacity: 1; }} {pct(a + 0.3)} {{ opacity: 0; }} {pct(b)} {{ opacity: 0; }} {pct(b + 0.4)} {{ opacity: 1; }}")
css_kf.append("@keyframes d-ph { 0% { opacity: 0; } " + " ".join(frames) + " 100% { opacity: 1; } }\n")
use(".app-ph", "d-ph", "linear")

html.append('''          <div class="app-msgs">
            <div class="m-empty">
              <i aria-hidden="true">◆</i>
              <p>Find a <b>free 3D model</b>, slice it, and print. Right from your phone.</p>
              <span>Find me a phone stand I can print today</span>
              <span>Slice this for strength, PETG, my Ender 3</span>
              <span>Show me a cable clip for a desk</span>
            </div>
''')
typed_spans = []

for i, sc in enumerate(SCENES):
    k = sc["key"]; t0 = i * SCENE
    e = lambda n: f"e-{k}-{n}"
    # composer
    typed_spans.append(f'<span class="app-typed {e("typed")}">{sc["typed"]}</span>')
    css_kf.append(typed(f"d-{k}-typed", t0 + T["type_start"], len(sc["typed"]), T["type_len"]))
    use(f".{e('typed')}", f"d-{k}-typed", "linear", ", d-caret 1s linear infinite")
    # user
    html.append(f'            <div class="m-user {e("user")}">{sc["user"]}</div>\n')
    css_kf.append(arrive(f"d-{k}-user", t0 + T["user"], 80))
    use(f".{e('user')}", f"d-{k}-user")
    # activity
    html.append(f'''            <div class="m-act {e("act")}"><span class="m-act-line">
              <i class="m-spin {e("acta")}"></i>
              <span class="m-act-a {e("acta")}">{sc["act_a"]}</span>
              <span class="m-act-b {e("actb")}">{sc["act_b"]}</span>
              <span class="m-act-n {e("actb")}">{sc["steps"]}</span>
            </span></div>
''')
    css_kf.append(arrive(f"d-{k}-act", t0 + T["act"], 40))
    use(f".{e('act')}", f"d-{k}-act")
    css_kf.append(fade_out(f"d-{k}-acta", t0 + T["found"], t0 + T["found"] + 0.4))
    css_kf.append(fade_in(f"d-{k}-actb", t0 + T["found"], t0 + T["found"] + 0.4))
    use(f".m-act-a.{e('acta')}", f"d-{k}-acta")
    use(f".m-spin.{e('acta')}", f"d-{k}-acta", extra=", spin 0.7s linear infinite")
    use(f".{e('actb')}", f"d-{k}-actb")
    # content
    html.append("            " + sc["content"] + "\n")
    css_kf.append(arrive(f"d-{k}-content", t0 + T["content"], sc["content_max"], lift=8))
    use(f".{e('content')}", f"d-{k}-content")
    if k == "a":
        for n in (1, 2, 3):
            css_kf.append(slide(f"d-a-card{n}", t0 + T["content"] + 0.25 * n))
            use(f".e-a-card{n}", f"d-a-card{n}")
    # bot
    html.append(f'            <div class="m-bot {e("bot")}"><span class="{e("caret")}">{sc["bot"]}</span></div>\n')
    css_kf.append(arrive(f"d-{k}-bot", t0 + T["bot"], 110))
    use(f".{e('bot')}", f"d-{k}-bot")
    css_kf.append(fade_out(f"d-{k}-caret", t0 + T["bot"] + T["bot_caret"], t0 + T["bot"] + T["bot_caret"] + 0.4))
    use(f".{e('caret')}::after", f"d-{k}-caret")
    # panel
    rows = ""
    for j, (label, value, width) in enumerate(sc["rows"], 1):
        rows += f'              <div class="m-row"><span class="m-k">{label}</span><span class="m-track"><i class="m-fill {e(f"fill{j}")}"></i></span><b class="m-v {e(f"v{j}")}">{value}</b></div>\n'
        tb = t0 + T["bars"][j - 1]
        css_kf.append(bar(f"d-{k}-fill{j}", tb, width, T["bar_len"]))
        use(f".{e(f'fill{j}')}", f"d-{k}-fill{j}")
        css_kf.append(fade_in(f"d-{k}-v{j}", tb + T["bar_len"] - 0.7, tb + T["bar_len"]))
        use(f".{e(f'v{j}')}", f"d-{k}-v{j}")
    actions = "".join(f'<i class="m-btn{" primary" if n == 0 else ""}">{a}</i>' for n, a in enumerate(sc["actions"]))
    html.append(f'''            <div class="m-panel {e("panel")}"><div class="m-panel-in">
              <div class="m-panel-h"><i aria-hidden="true">✦</i>{sc["panel_title"]}</div>
{rows}              <div class="m-tail {e("tail")}"><span class="m-actions">{actions}</span></div>
            </div></div>
''')
    css_kf.append(arrive(f"d-{k}-panel", t0 + T["panel"], 240))
    use(f".{e('panel')}", f"d-{k}-panel")
    css_kf.append(fade_in(f"d-{k}-tail", t0 + T["tail"], t0 + T["tail"] + 0.6))
    use(f".{e('tail')}", f"d-{k}-tail")
    # toast
    css_kf.append(window(f"d-{k}-toast", t0 + T["toast"], t0 + T["toast"] + T["toast_len"]))
    use(f".{e('toast')}", f"d-{k}-toast")

html.append("          </div>\n\n")
for sc in SCENES:
    html.append(f'          <div class="app-toast e-{sc["key"]}-toast">{sc["toast"]}</div>\n')
html.append("\n")
html.append(f'''          <div class="app-composer">
            <div class="app-pickers">
              <span class="app-picker"><i class="app-dot"></i>Claude Sonnet 5 <em>▾</em></span>
              <span class="app-picker">medium <em>▾</em></span>
            </div>
            <div class="app-row">
              <span class="app-circ"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span>
              <span class="app-circ"><svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></svg></span>
              <span class="app-input">{"".join(typed_spans)}<span class="app-ph">Ask, paste a link, or drop an STL to slice…</span></span>
              <span class="app-send"><svg viewBox="0 0 24 24"><path d="M12 19V6M12 6l-6 6M12 6l6 6"/></svg></span>
            </div>
          </div>
''')

# ---------------------------------------------------------------- write ----
def splice(path, start, end, body):
    s = Path(path).read_text()
    a = s.index(start) + len(start)
    b = s.index(end)
    Path(path).write_text(s[:a] + "\n" + body + s[b:])

splice(ROOT / "index.html", "          <!-- demo:start -->", "          <!-- demo:end -->", "".join(html))

css = f"""/* Generated by scripts/gen-site-demo.py — do not edit by hand.
   One {LOOP:g} s loop: three exchanges of {SCENE:g} s each, then the transcript fades
   and the conversation starts over. Every element grows from the bottom of
   the bottom-anchored transcript (pushing the older ones up, the way a chat
   scrolls) while it fades and rises in. */
@keyframes d-caret {{ 0%, 49% {{ border-right-color: var(--accent); }} 50%, 100% {{ border-right-color: transparent; }} }}
{"".join(css_kf)}
{chr(10).join(css_use)}

/* Reduced motion: freeze on the last exchange, finished, rather than on an
   empty window. Seeks every paused animation to {SEEK} s. */
@media (prefers-reduced-motion: reduce) {{
{chr(10).join(css_rm)}
}}
"""
splice(ROOT / "styles.css", "/* demo-timeline:start */", "/* demo-timeline:end */", css)
print(f"loop {LOOP}s, reduced-motion seek {SEEK}s, {len(css_kf)} keyframe sets")
