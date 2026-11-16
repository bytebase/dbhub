import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "assets/branding");
const copies = {
  "svg/dbhub-logo-light.svg": ["docs/images/logo/full-light.svg", "frontend/public/logo-full-light.svg"],
  "svg/dbhub-logo-dark.svg": ["docs/images/logo/full-dark.svg", "frontend/public/logo-full-dark.svg"],
  "svg/dbhub-wordmark-light.svg": ["docs/images/logo/text-light.svg"],
  "svg/dbhub-wordmark-dark.svg": ["docs/images/logo/text-dark.svg"],
  "svg/dbhub-icon-light.svg": ["docs/images/logo/icon.svg"],
  "svg/dbhub-icon-dark.svg": ["docs/images/logo/icon-dark.svg"],
  "png/dbhub-icon-light-512.png": ["mcpb/icon.png"],
};

for (const [asset, destinations] of Object.entries(copies)) {
  for (const destination of destinations) {
    copyFileSync(join(source, asset), join(root, destination));
  }
}

// Browser tabs follow the OS theme independently of the page's theme class.
const icon = readFileSync(join(source, "svg/dbhub-icon-light.svg"), "utf8");
const favicon = icon.replace(
  /(<svg[^>]*>)/,
  "$1\n<style>@media (prefers-color-scheme: dark) { path { fill: #FFFFFF; } }</style>"
);
for (const destination of ["docs/favicon.svg", "frontend/public/favicon.svg"]) {
  writeFileSync(join(root, destination), favicon);
}
