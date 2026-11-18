import os from "os";
import path from "path";

/**
 * Expand a leading `~/` to the current user's home directory; any other path
 * is returned unchanged. The one implementation behind every path option that
 * accepts `~/` — SSH keys and agent sockets, PEM files, the Oracle wallet
 * directory, the `--config` path — so they cannot disagree about what `~`
 * means.
 *
 * The home directory comes from `os.homedir()`, not `$HOME`: on Windows `HOME`
 * is usually unset, and joining with an empty string would quietly turn
 * `~/.ssh/id_rsa` into the relative path `.ssh/id_rsa`.
 *
 * SQLite database paths have their own rules (drive letters, `~\`, resolution
 * against the config file) and are handled in sqlite-dsn.ts.
 */
export function expandHomeDir(filePath: string): string {
  return filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
}
