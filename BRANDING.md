# DBHub branding

DBHub uses a starfish symbol and an outlined wordmark in Zinc and white. The
starfish's five arms and small cutouts remain part of the artwork at every size.

![DBHub logo on light and dark backgrounds](assets/branding/preview.png)

## Source assets

The complete logo pack lives in [`assets/branding/`](assets/branding/). It contains
six SVGs, 22 transparent PNGs, a preview, and the original export notes. These are
the source files for the copies used by the website, workbench, and MCP bundle.
The pack was exported on November 16, 2026; its Figma source is recorded in
[`README.txt`](assets/branding/README.txt).

| Use | Light background | Dark background |
| --- | --- | --- |
| Full logo | `svg/dbhub-logo-light.svg` | `svg/dbhub-logo-dark.svg` |
| Starfish icon | `svg/dbhub-icon-light.svg` | `svg/dbhub-icon-dark.svg` |
| Wordmark | `svg/dbhub-wordmark-light.svg` | `svg/dbhub-wordmark-dark.svg` |

Names refer to the **background**: `light` files contain Zinc artwork; `dark`
files contain white artwork. Prefer SVG for the web. The lettering is outlined
and does not require a font. PNG logos are available at 512, 1024, and 2048 pixels
wide; icons at 32–1024 pixels square; wordmarks at 512 and 1024 pixels wide.

## Logo placement

- Use the complete logo asset when displaying the symbol and wordmark together.
  Keep its original proportions, spacing, and optical alignment.
- Leave clear space of at least one quarter of the starfish's height on all sides.
  The SVG does not include this external clear space; provide it in the layout.
- The source starfish is 136 units tall, the lettering is 103 units tall, and the
  gap is 24 units. The starfish is optically raised by 5 units.
- Use the icon alone for favicons and app icons. Prefer the full logo where the
  name needs to be readable; use the icon if the available space is too small.
- Keep the artwork flat and monochrome. Do not stretch, rotate, recolor, add
  shadows, fill the cutouts, or recreate the wordmark with live text.
- Give standalone logo images `alt="DBHub"`. For a linked home logo, label the
  link `DBHub home` and use empty image alt text to avoid duplicate announcements.

## Color theme

| Color | Value | Role |
| --- | --- | --- |
| Zinc | `#323236` / RGB `50, 50, 54` | Logo on light backgrounds; primary actions and text |
| White | `#FFFFFF` / RGB `255, 255, 255` | Logo on dark backgrounds; light canvas and inverse text |

The workbench expresses Zinc as `oklch(0.319 0.007 286)` and white as
`oklch(1 0 0)`. Zinc is rounded to three decimals; the exported SVG and PNG files
retain the exact source color. White and Zinc have approximately 12.76:1 contrast.

Use the semantic tokens in [`frontend/src/index.css`](frontend/src/index.css)
instead of adding raw colors to components:

| Role | Light mode | Dark mode |
| --- | --- | --- |
| Background | White | Zinc 950 |
| Card | White | Zinc 900 |
| Popover | White | Brand Zinc |
| Foreground | Brand Zinc | Zinc 100 |
| Primary / primary foreground | Brand Zinc / white | White / brand Zinc |
| Muted surface | Zinc 100 | Zinc 900 |
| Accent surface | Zinc 200 | Brand Zinc |
| Secondary surface | Zinc 100 | Brand Zinc |
| Muted text | Zinc 500 mixed 80% with brand Zinc | Zinc 400 |
| Focus ring | Zinc 500 | Zinc 400 |
| Border and input | Brand Zinc at 12% opacity | Zinc 700 |

Supporting Zinc shades come from Tailwind's existing OKLCH palette. Dark surfaces
become lighter as they rise above the canvas. Use `bg-muted` for the sidebar and
the matching light/dark logo variant. The workbench's `.dark` class controls the
theme; the logo follows that class. Browser favicons follow the OS color scheme.
The SQL editor uses the same surface, selection, cursor, and focus tokens.

Reserve red for destructive actions and errors, emerald for success, amber for
warnings, and blue for informational states. These functional colors remain
distinct from the monochrome brand. Pair status colors with text or icons. Check
body text at 4.5:1 contrast or better and visible focus indicators at 3:1 or better.

The documentation site's [`docs/docs.json`](docs/docs.json) uses Zinc for
`colors.primary` and `colors.dark`, and white for `colors.light` (dark-mode
emphasis). These fields require hex values in the
[Mintlify configuration](https://www.mintlify.com/docs/organize/settings-reference).
Keep DM Sans for documentation text and the existing system font stack in the
workbench; the custom logo lettering is artwork, not a UI typeface.

## Updating assets

1. Replace the files in `assets/branding/` with the new export, preserving names.
2. Run `pnpm run sync:branding` to update all published copies.
3. If the palette changes, update the semantic theme and `docs/docs.json`, then
   update this guide.
4. Run `pnpm run build:frontend` and inspect light and dark logo variants,
   favicons, navigation, text, buttons, and focus states.

The sync script maintains the existing `docs/images/logo/` URLs used by the
README and documentation, the workbench's public assets, and `mcpb/icon.png`
(the 512-pixel Zinc icon). It also adds dark-mode styling to the two favicons
without changing the source SVG geometry. Do not edit these generated copies by
hand; rerunning the command will overwrite them.
