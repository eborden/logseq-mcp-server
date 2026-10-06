/**
 * Write the hub fixture (#89) into tests/fixtures/graph, or check that it is up to date.
 *
 *   npx tsx scripts/generate-hub-fixture.ts          # write the files
 *   npx tsx scripts/generate-hub-fixture.ts --check  # exit 1 if a committed file differs
 *
 * The content comes from scripts/fixture-hub/hub-graph.ts. It deletes only the files it owns
 * (pages/hub central.md and pages/neighbour-*.md), so pages written by hand for other fixture
 * content are never touched. Commit the output.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { HUB_PAGE, buildHubFixture } from './fixture-hub/hub-graph.js';

const graphDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests/fixtures/graph');
const files = buildHubFixture();
const check = process.argv.includes('--check');

const owned = (name: string) => name === `${HUB_PAGE}.md` || name.startsWith('neighbour-');
const stale = readdirSync(join(graphDir, 'pages'))
  .filter(owned)
  .map(name => `pages/${name}`)
  .filter(path => !files.has(path));

const differing = [...files].filter(([path, content]) => {
  const full = join(graphDir, path);
  return !existsSync(full) || readFileSync(full, 'utf8') !== content;
});

if (check) {
  for (const path of [...differing.map(([p]) => p), ...stale]) console.error(`out of date: ${path}`);
  process.exit(differing.length + stale.length > 0 ? 1 : 0);
}

for (const [path, content] of differing) {
  mkdirSync(dirname(join(graphDir, path)), { recursive: true });
  writeFileSync(join(graphDir, path), content);
}
for (const path of stale) rmSync(join(graphDir, path));
console.error(`wrote ${differing.length} files, removed ${stale.length}, ${files.size} owned in total`);
