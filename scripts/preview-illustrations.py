"""Build the illustration guide and local preview from the shared catalog.

Run: python3 scripts/preview-illustrations.py
Preview: python3 -m http.server 3003 --bind 127.0.0.1 --directory /tmp/dbhub-sea-preview
"""
from pathlib import Path
import html
import json

ROOT = Path(__file__).resolve().parents[1] / "docs/images/illustrations"
OUTPUT = Path("/tmp/dbhub-sea-preview")
groups = json.loads((ROOT / "catalog.json").read_text())
count = sum(len(group["items"]) for group in groups)
lines = [
    "# Sea illustration set", "",
    f"{count} reusable SVGs for DBHub documentation and marketing. `catalog.json` is the source of truth for the mappings and preview.", "",
    "## Choosing an illustration", "",
    "- Use a docs illustration for its assigned task consistently across pages.",
    "- Use editorial metaphors when the adjacent copy makes the meaning clear.",
    "- Use brand illustrations freely in decorative compositions; they do not need a technical meaning.",
    "- Keep literal headings and link labels. Illustrations support the text rather than replace it.",
    "- A metaphor describes a topic, not a product capability. Avoid using artwork to imply automatic tuning, alerting, or guaranteed security.",
    "- Existing landing-page compositions may use the illustrations decoratively; these mappings do not require changing them.", "",
    "## Style", "",
    "- Canvas: `264 × 176`, transparent background.",
    "- Stroke: `2.2px`, `#323236`, round caps and joins. The original seastar uses its logo path at an equivalent 2.1px stroke.",
    "- Smooth curves, minimal interior detail, and consistent optical scale. No hatching or gray accent strokes.",
    "- Use at approximately 176–264px wide, preserving the canvas. These are illustrations, not small navigation icons.",
    "- Dark mode: `filter: invert(1)`.",
    ' - Decorative images use `alt=""`; standalone meaningful images need an accessible description.'.strip(), "",
]
for group in groups:
    lines += ["## " + group["title"], "", group["description"], "", "| Illustration | Use | Meaning |", "| --- | --- | --- |"]
    for item in group["items"]:
        use = item["meaning"]
        if item["href"]:
            use = f'[{use}](https://dbhub.ai{item["href"]})'
        lines.append(f'| [{item["subject"]}]({item["asset"]}) | {use} | {item["description"]} |')
    lines.append("")
lines += ["## Preview", "", "Run `python3 scripts/preview-illustrations.py` from the repository root to regenerate this guide and `/tmp/dbhub-sea-preview/index.html`.", ""]
(ROOT / "README.md").write_text("\n".join(lines))

STYLES = '*{box-sizing:border-box}body{--bg:#fff;--surface:#f4f5f5;--text:#323236;--muted:#65656a;--border:#e6e7e7;margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}body.dark{--bg:#0e0e10;--surface:#18181b;--text:#eeeef0;--muted:#aaaab0;--border:#2b2b30}main{max-width:1250px;margin:0 auto;padding:48px 32px}header{display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:36px}h1{font-size:32px;letter-spacing:-1px;margin:4px 0 8px;font-weight:600}p{margin:0;color:var(--muted)}.eyebrow{font-size:12px;letter-spacing:1px;text-transform:uppercase}button{border:1px solid var(--border);border-radius:8px;padding:12px 16px;background:var(--surface);color:var(--text);font:inherit;cursor:pointer}button:focus-visible{outline:2px solid #2aa1fe;outline-offset:3px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px}.card{border:1px solid var(--border);border-radius:12px;overflow:hidden}.art{height:176px;display:flex;justify-content:center;align-items:center;background:var(--surface)}.art svg{width:264px;max-width:100%;height:auto}.dark svg{filter:invert(1)}.copy{padding:18px 20px 22px}h2{font-size:17px;line-height:1.3;font-weight:500;margin:0 0 7px}.file{font:12px ui-monospace,monospace;color:var(--muted)}.copy p{font-size:13px;margin-top:10px}footer{margin-top:32px;color:var(--muted);font-size:13px}@media(max-width:950px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:700px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}main{padding:24px 16px}h1{font-size:26px}}@media(max-width:440px){.grid{grid-template-columns:1fr}header{align-items:flex-start}button{font-size:13px;white-space:nowrap}}section{margin:44px 0 56px}.section-title{font-size:24px;letter-spacing:-.5px;margin:0 0 8px}.section-intro{margin-bottom:24px;max-width:70ch}.meaning{display:block;font-size:13px;font-weight:500;margin-top:12px;color:var(--text)}nav{display:flex;flex-wrap:wrap;gap:24px;margin-bottom:24px}nav a{color:var(--text);text-underline-offset:5px}section{scroll-margin-top:24px}'

sections = []
for group in groups:
    cards = []
    for item in group["items"]:
        svg = (ROOT / item["asset"]).read_text()
        cards.append(f'<article class="card"><div class="art" aria-hidden="true">{svg}</div><div class="copy"><h2>{html.escape(item["subject"])}</h2><span class="file">{item["asset"]}</span><span class="meaning">{html.escape(item["meaning"])}</span><p>{html.escape(item["description"])}</p></div></article>')
    sections.append(f'<section id="{group["id"]}"><h2 class="section-title">{group["title"]} <span class="file">{len(group["items"])}</span></h2><p class="section-intro">{group["description"]}</p><div class="grid">'+"".join(cards)+"</div></section>")
nav = "".join(f'<a href="#{g["id"]}">{g["title"]}</a>' for g in groups)
OUTPUT.mkdir(exist_ok=True)
(OUTPUT / "index.html").write_text(f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DBHub · Sea illustration set</title><style>{STYLES}</style></head><body><main><header><div><p class="eyebrow">DBHub / Illustration library</p><h1>Sea illustrations, with a clear purpose.</h1><p>{count} illustrations for docs, editorial stories, and brand compositions.</p></div><button onclick="document.body.classList.toggle(\'dark\')" aria-label="Toggle dark theme">Light / dark</button></header><nav aria-label="Illustration groups">{nav}</nav>'+"".join(sections)+'<footer>Mappings and usage guidance: docs/images/illustrations/catalog.json</footer></main></body></html>')
print(f"Generated guide and preview for {count} illustrations.")
