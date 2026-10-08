import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeOracle, ORACLE_NAMES, ORACLE_SEARCHES } from '../scripts/parity/fuzzysort-oracle.js';
import { REPO_ROOT } from '../scripts/parity/ts-server.js';

/**
 * The Rust port of fuzzysort (rust/src/fuzzy.rs, #125) is tested against
 * rust/tests/data/fuzzysort-oracle.json. This recomputes that file with the fuzzysort the
 * TypeScript server runs, so a release that changes a score or the order of equal scores fails
 * here instead of leaving the Rust suggestions out of step while `cargo test` stays green.
 * Regenerate with `npx tsx scripts/parity/fuzzysort-oracle.ts > rust/tests/data/fuzzysort-oracle.json`.
 */
describe('the fuzzysort oracle of the Rust port', () => {
  it('is what the installed fuzzysort returns today', async () => {
    const committed = JSON.parse(await readFile(join(REPO_ROOT, 'rust', 'tests', 'data', 'fuzzysort-oracle.json'), 'utf8'));
    expect(computeOracle()).toEqual(committed);
  });

  it('covers every search at the limit the suggestions use and with none', () => {
    const oracle = computeOracle();
    expect(oracle.names).toEqual(ORACLE_NAMES);
    expect(oracle.limited.map(c => c.search)).toEqual(ORACLE_SEARCHES);
    expect(oracle.full.map(c => c.search)).toEqual(ORACLE_SEARCHES);
    expect(oracle.limited.every(c => c.results.length <= 3)).toBe(true);
    // some searches have ties and some have no match, so the heap order and the empty answer are in it
    expect(oracle.full.some(c => new Set(c.scores).size < c.scores.length)).toBe(true);
    expect(oracle.full.some(c => c.results.length === 0)).toBe(true);
  });
});
