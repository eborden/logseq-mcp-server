// The environment the Node tooling runs the Rust server in (the measure scripts, the guard tests that start the
// binary): the config pointed at a stub, the clock and the zone fixed, and every home and config directory a server
// could look in for a fallback config (`~/.logseq-mcp/`) moved to an empty temp dir, so a server that ignores
// LOGSEQ_MCP_CONFIG can't reach a real LogSeq (BR-0001). The parity test sets the same variables in Rust
// (`Server::command` in rust/tests/parity_support/server.rs).
import { join } from 'node:path';

/**
 * The instant every server under test reads as "now" (`LOGSEQ_MCP_NOW`, milliseconds since 1970-01-01 UTC):
 * 2025-03-12T03:30:00Z, which is still the evening of Tuesday 2025-03-11 in `PARITY_TZ`.
 */
export const PARITY_NOW_MS = Date.UTC(2025, 2, 12, 3, 30);

/** The time zone every server under test runs in (`TZ`): one with daylight saving, and not UTC. */
export const PARITY_TZ = 'America/New_York';

/**
 * The caller's environment, with the config pointed at the stub, tips left at their default, the clock fixed at
 * {@link PARITY_NOW_MS} in {@link PARITY_TZ}, and every home and config directory moved to `home`, an empty temp dir.
 */
export function sandboxedEnv(configPath: string, home: string, now: number = PARITY_NOW_MS): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.LOGSEQ_MCP_TIPS;
  env.LOGSEQ_MCP_CONFIG = configPath;
  env.LOGSEQ_MCP_NOW = String(now);
  env.TZ = PARITY_TZ;
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  // macOS looks the home folder up by user, not $HOME, unless this is set (see scripts/logseq-instance)
  if (process.platform === 'darwin') env.CFFIXED_USER_HOME = home;
  return env;
}
