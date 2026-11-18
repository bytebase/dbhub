import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "assets/branding");
const copies = {
  "svg/dbhub-logo-for-light-background.svg": [
    "docs/images/logo/full-light.svg",
    "frontend/public/logo-full-light.svg",
  ],
  "svg/dbhub-logo-for-dark-background.svg": [
    "docs/images/logo/full-dark.svg",
    "frontend/public/logo-full-dark.svg",
  ],
  "svg/dbhub-wordmark-for-light-background.svg": ["docs/images/logo/text-light.svg"],
  "svg/dbhub-wordmark-for-dark-background.svg": ["docs/images/logo/text-dark.svg"],
  // The gradient icon reads on light and dark backgrounds, so one file serves
  // both icon URLs and the favicons (no per-theme variant or OS-scheme styling).
  "svg/dbhub-icon-transparent.svg": [
    "docs/images/logo/icon.svg",
    "docs/images/logo/icon-dark.svg",
    "docs/favicon.svg",
    "frontend/public/favicon.svg",
  ],
  "png/512w/dbhub-icon-transparent-512w.png": ["mcpb/icon.png", "plugin/assets/icon.png"],
};

for (const [asset, destinations] of Object.entries(copies)) {
  for (const destination of destinations) {
    copyFileSync(join(source, asset), join(root, destination));
  }
}
