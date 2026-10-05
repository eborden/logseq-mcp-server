import { readFileSync } from 'fs';

/**
 * The package version, read from package.json so `serverInfo.version` in the MCP
 * `initialize` response can't go stale. npm always ships package.json, and it sits
 * one directory above both `src/` and `dist/`, so the same relative path works
 * under vitest and in the published package.
 */
function readPackageVersion(): string {
  const path = new URL('../package.json', import.meta.url);
  const pkg: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  const version = (pkg as { version?: unknown } | null)?.version;
  if (typeof version !== 'string' || version === '') {
    throw new Error(`package.json at ${path.pathname} has no "version" string`);
  }
  return version;
}

export const SERVER_VERSION: string = readPackageVersion();
