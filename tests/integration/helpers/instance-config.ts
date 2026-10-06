import { existsSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Which config the integration tests and `scripts/probe-constraints.ts` use (#90). They never
 * read `~/.logseq-mcp/config.json`: that file points at the maintainer's personal LogSeq, and
 * nothing here may contact it, not even for the one sentinel lookup that would refuse it.
 *
 * - `LOGSEQ_MCP_CONFIG`, when set (an absolute path, as for the server);
 * - else this checkout's `.logseq-instance/config.json`, which
 *   `npx tsx scripts/logseq-instance.ts start` writes and `stop` deletes;
 * - else nothing: `FixtureConfigError`, before any network call.
 *
 * Plain Node only (no `src/` imports), so `vitest.integration.config.ts` can load it.
 */

export const CONFIG_PATH_ENV = 'LOGSEQ_MCP_CONFIG';

/** The port of LogSeq's own HTTP API server, which a personal LogSeq uses. */
export const PERSONAL_LOGSEQ_PORT = 12315;

export const HOW_TO_RUN =
  'Start this worktree\'s fixture instance with `npx tsx scripts/logseq-instance.ts start`, then run ' +
  '`npm run test:integration` (it finds .logseq-instance/config.json by itself), then ' +
  '`npx tsx scripts/logseq-instance.ts stop`. See "Running the integration tests" in tests/integration/setup.md.';

/** No config to use, or one that points at a personal LogSeq. Thrown before any network call. */
export class FixtureConfigError extends Error {
  constructor(message: string) {
    super(`${message}\n${HOW_TO_RUN}`);
    this.name = 'FixtureConfigError';
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** This checkout's instance config, whether or not it exists. */
export function instanceConfigPath(root: string = repoRoot): string {
  return join(root, '.logseq-instance', 'config.json');
}

/**
 * The config path to load: `LOGSEQ_MCP_CONFIG`, else the instance config when it exists.
 * Never the default `~/.logseq-mcp/config.json`.
 *
 * @throws FixtureConfigError when the variable is relative, or unset with no instance running
 */
export function resolveFixtureConfigPath(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
  root: string = repoRoot
): string {
  const raw = env[CONFIG_PATH_ENV]?.trim();
  if (raw) {
    if (!isAbsolute(raw)) throw new FixtureConfigError(`${CONFIG_PATH_ENV} must be an absolute path (got "${raw}").`);
    return raw;
  }
  const instance = instanceConfigPath(root);
  if (exists(instance)) return instance;
  throw new FixtureConfigError(
    `No fixture instance is running (no ${instance}) and ${CONFIG_PATH_ENV} is unset. ` +
      'The integration tests and probe-constraints never fall back to ~/.logseq-mcp/config.json.'
  );
}

/**
 * Refuse a config whose API is on LogSeq's default port, 12315: that is a personal LogSeq, and
 * the fixture instance always uses 12320-12399. The URL is parsed, never fetched.
 *
 * @throws FixtureConfigError for port 12315, or an apiUrl that is not a URL
 */
export function assertNotPersonalLogseq(apiUrl: string): void {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new FixtureConfigError(`The config's apiUrl is not a URL.`);
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (port === PERSONAL_LOGSEQ_PORT) {
    throw new FixtureConfigError(
      `The config points at port ${PERSONAL_LOGSEQ_PORT}, LogSeq's default port, which is a personal LogSeq. ` +
        'The integration tests run only against the fixture instance (ports 12320-12399).'
    );
  }
}
