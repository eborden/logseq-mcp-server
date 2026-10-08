/**
 * Write the parity cases and their golden results as JSON for the cargo test (#371), or check that they are up to date.
 *
 *   npx vite-node scripts/export-parity.ts          # write rust/tests/data/parity/*.json
 *   npx vite-node scripts/export-parity.ts --check  # exit 1 if a committed file differs
 *
 * The content comes from scripts/parity/export.ts. The golden files (scripts/parity/expected) are only read. Commit the output.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPORT_DIR, buildExport, strayFiles } from './parity/export.js';

const files = buildExport();
const differing = [...files].filter(([name, content]) => {
  const full = join(EXPORT_DIR, name);
  return !existsSync(full) || readFileSync(full, 'utf8') !== content;
});
const stray = strayFiles(files);

if (process.argv.includes('--check')) {
  for (const [name] of differing) console.error(`out of date: rust/tests/data/parity/${name}`);
  for (const name of stray) console.error(`stray: rust/tests/data/parity/${name}`);
  if (differing.length + stray.length > 0) console.error('run: npx vite-node scripts/export-parity.ts');
  process.exit(differing.length + stray.length > 0 ? 1 : 0);
}

mkdirSync(EXPORT_DIR, { recursive: true });
for (const [name, content] of differing) writeFileSync(join(EXPORT_DIR, name), content);
for (const name of stray) rmSync(join(EXPORT_DIR, name));
console.error(`wrote ${differing.length} files, removed ${stray.length}, ${files.size} in total`);
