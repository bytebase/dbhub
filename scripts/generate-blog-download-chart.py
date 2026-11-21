"""Render the DBHub 2.0 announcement chart from the saved trailing 30-day npm totals.

Requires matplotlib. Run from any directory with Python 3.
"""

import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter, MultipleLocator


assets = Path(__file__).resolve().parents[1] / "docs/images/blog/dbhub-2-0-0"
data = json.loads((assets / "npm-monthly-downloads.json").read_text())
months = list(data["series"][0]["downloads"])
plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 11,
    "axes.unicode_minus": False,
    "text.color": "#323236",
    "axes.labelcolor": "#52525B",
    "xtick.color": "#52525B",
    "ytick.color": "#52525B",
    "svg.hashsalt": "dbhub-monthly-downloads",
})
fig, ax = plt.subplots(figsize=(11, 5.3), facecolor="white")
fig.subplots_adjust(left=0.075, right=0.765, bottom=0.19, top=0.79)
fig.text(0.075, 0.915, "Trailing 30-day npm downloads", fontsize=20, weight="semibold")

brand_violet = "#955BFE"
brand_zinc = "#323236"

for series, color, style in zip(
    data["series"], [brand_violet, brand_zinc], ["-", (0, (4, 3))]
):
    values = [series["downloads"][month] for month in months]
    ax.plot(range(12), values, color=color, linewidth=2.6, linestyle=style,
            solid_capstyle="round", dash_capstyle="round")
    ax.plot(11, values[-1], "o", color=color, markersize=7, markeredgecolor="white", markeredgewidth=1.5)
    label = "DBHub" if series["label"] == "DBHub" else "MCP Toolbox\nby Google"
    ax.annotate(f"{values[-1]:,}", (11, values[-1]), xytext=(16, 4),
                textcoords="offset points", fontsize=18, weight="semibold", color=brand_zinc)
    ax.annotate(label, (11, values[-1]), xytext=(16, -15),
                textcoords="offset points", fontsize=11, color=brand_zinc, va="top", linespacing=1.4)

ax.set_xlim(-0.25, 11.25)
ax.set_ylim(0, 400000)
ax.set_xticks([0, 3, 6, 9, 11], ["Dec 2025", "Mar", "Jun", "Sep", "Nov 2026"])
ax.yaxis.set_major_locator(MultipleLocator(200000))
ax.yaxis.set_major_formatter(FuncFormatter(lambda value, _: "0" if value == 0 else f"{value / 1000:.0f}k"))
ax.grid(axis="y", color="#323236", alpha=0.10, linewidth=0.7)
ax.set_axisbelow(True)
ax.tick_params(axis="both", length=0, pad=10)
for spine in ax.spines.values():
    spine.set_visible(False)
fig.text(0.075, 0.045, "Source: npm Downloads API · Each point ends on the 20th of the month.",
         fontsize=10, color="#52525B")
fig.savefig(assets / "npm-monthly-downloads.svg", metadata={"Date": None})
fig.savefig("/tmp/dbhub-npm-monthly-downloads.png", dpi=180)
plt.close(fig)
