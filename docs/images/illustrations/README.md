# Sea illustration set

35 reusable SVGs for DBHub documentation and marketing. `catalog.json` is the source of truth for the mappings and preview.

## Choosing an illustration

- Use a docs illustration for its assigned task consistently across pages.
- Use editorial metaphors when the adjacent copy makes the meaning clear.
- Use brand illustrations freely in decorative compositions; they do not need a technical meaning.
- Keep literal headings and link labels. Illustrations support the text rather than replace it.
- A metaphor describes a topic, not a product capability. Avoid using artwork to imply automatic tuning, alerting, or guaranteed security.
- Existing landing-page compositions may use the illustrations decoratively; these mappings do not require changing them.

## Style

- Canvas: `264 × 176`, transparent background.
- Stroke: `2.2px`, `#323236`, round caps and joins. The original seastar uses its logo path at an equivalent 2.1px stroke.
- Smooth curves, minimal interior detail, and consistent optical scale. No hatching or gray accent strokes.
- Use at approximately 176–264px wide, preserving the canvas. These are illustrations, not small navigation icons.
- Dark mode: `filter: invert(1)`.
- Decorative images use `alt=""`; standalone meaningful images need an accessible description.

## Docs illustrations

Preferred pairings for concrete tasks. Keep the same pairing wherever the topic appears.

| Illustration | Use | Meaning |
| --- | --- | --- |
| [Sailboat](sailboat.svg) | [Quickstart](https://dbhub.ai/quickstart) | Starting the journey with a first connection. |
| [Anchor](anchor.svg) | [Installation](https://dbhub.ai/installation) | Establishing a starting point. |
| [Ship’s wheel](wheel.svg) | [Configuration](https://dbhub.ai/config/toml) | Controlling how DBHub runs. |
| [Octopus](octopus.svg) | [MCP tools](https://dbhub.ai/tools/overview) | Several capabilities available through one server. |
| [Diving goggles](diving-mask.svg) | [Schema exploration](https://dbhub.ai/tools/search-objects) | Looking closely at tables, columns, and indexes. |
| [Current](current.svg) | [SQL execution](https://dbhub.ai/tools/execute-sql) | A request flowing through to its result. |
| [Message in a bottle](bottle.svg) | [Custom tools](https://dbhub.ai/tools/custom-tools) | Packaging a reusable SQL operation. |
| [Coral](coral.svg) | [Multiple sources](https://dbhub.ai/config/toml#configuration-structure) | Several database connections branching from one process. |
| [Harbor](harbor.svg) | [Workbench](https://dbhub.ai/workbench/overview) | A place to run and inspect database tools. |
| [Porthole](porthole.svg) | [Results inspection](https://dbhub.ai/workbench/tool-execution) | A window into a tool’s output. |
| [Sea chart](chart.svg) | [Request traces](https://dbhub.ai/workbench/request-trace) | Following the path of a request. |
| [Pressure gauge](pressure-gauge.svg) | [Health checks](https://dbhub.ai/tools/health-check) | Reading the current state of a connection. |
| [Lifebuoy](lifebuoy.svg) | [Read-only guardrails](https://dbhub.ai/config/read-only-mode) | Protection around database access. |
| [Buoy](buoy.svg) | [Query limits](https://dbhub.ai/config/toml#tool-options) | Marking boundaries such as row limits and timeouts. |
| [Treasure chest](chest.svg) | [Credentials](https://dbhub.ai/config/toml#environment-variable-interpolation) | Sensitive information used to connect to a database. |
| [Submarine](submarine.svg) | [SSH tunnels](https://dbhub.ai/config/toml#ssh-tunnel-options) | Reaching a database through an indirect route. |
| [Pearl shell](pearl.svg) | [Curated data access](https://dbhub.ai/mcpb) | Making selected data available to a team. |

## Editorial metaphors

Use when the surrounding copy establishes the connection. These are not fixed feature symbols.

| Illustration | Use | Meaning |
| --- | --- | --- |
| [Iceberg](iceberg.svg) | [Hidden overhead](https://dbhub.ai/blog/database-mcp-server-token-benchmark-2026) | The visible tip contrasts with the larger context cost below. |
| [Nautilus](nautilus.svg) | Looking beneath the surface | A supporting image for query plans or investigating data issues. |
| [Sonar](sonar.svg) | Discovery | Finding something that is not immediately visible. |
| [Shoal](shoal.svg) | Many working together | Useful for connection pools or groups of sources when the copy names them. |
| [Ship’s bell](ships-bell.svg) | Announcements | Drawing attention to release notes or important notices. |
| [Dock cleat](dock-cleat.svg) | Holding a connection | Keeping a connection in place. |
| [Lighthouse](lighthouse.svg) | Guidance | Helping readers find their way through a guide or troubleshooting article. |
| [Clownfish](clownfish.svg) | [Demo experience](https://dbhub.ai/quickstart) | A friendly recurring character for sample data and first-run examples. |

## Brand illustrations

Use for warmth, variety, and sea-themed compositions. No fixed technical meaning.

| Illustration | Use | Meaning |
| --- | --- | --- |
| [Seastar](seastar.svg) | Primary brand motif | The original DBHub silhouette; the default for brand-led compositions. |
| [Seahorse](seahorse.svg) | Supporting sea life | A tall silhouette with a curled tail. |
| [Crab](crab.svg) | Supporting sea life | A broad silhouette with expressive claws. |
| [Jellyfish](jellyfish.svg) | Supporting sea life | Soft curves and trailing tentacles. |
| [Sea turtle](sea-turtle.svg) | Supporting sea life | A calm rounded form with a distinctive shell. |
| [Fish](fish.svg) | Supporting sea life | A simple horizontal companion to the seastar. |
| [Manta ray](manta-ray.svg) | Supporting sea life | A flowing wide silhouette. |
| [Whale](whale.svg) | Supporting sea life | A large rounded silhouette. |
| [Diving fins](diving-fins.svg) | Supporting dive equipment | Equipment for underwater exploration scenes. |
| [Seaweed](seaweed.svg) | Supporting scenery | Organic framing and background detail. |

## Preview

Run `python3 scripts/preview-illustrations.py` from the repository root to regenerate this guide and `/tmp/dbhub-sea-preview/index.html`.
