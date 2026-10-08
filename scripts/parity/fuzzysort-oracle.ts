// The oracle for the Rust port of fuzzysort (rust/src/fuzzy.rs, #125): what the installed fuzzysort
// returns, with the options `suggestPages` passes (src/utils/resolve-page.ts), for made-up page names
// and searches (BR-0001). The Rust tests read it from rust/tests/data/fuzzysort-oracle.json; a vitest
// test (src/fuzzysort-oracle.test.ts) recomputes it here and fails when the committed file drifts from
// the library the TypeScript server runs, so a fuzzysort release that changes a score or the order of
// equal scores can't leave the Rust port green and wrong.
//
//   npx tsx scripts/parity/fuzzysort-oracle.ts > rust/tests/data/fuzzysort-oracle.json   # regenerate
//
// Scores are written as `String(score)`, since a JSON number read back by serde_json can be a unit
// in the last place off, and the Rust test parses the text with `str::parse`.
import Fuzzysort from 'fuzzysort';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export const ORACLE_NAMES = [
  'Alice', 'Alice Notes', 'Bob', 'Project Atlas', 'Project Atlas/Log', 'Project Atlas/Retro', 'atlas',
  'Café Menu', 'cafe', 'Résumé', 'Jan 1st, 2025', 'Weekly Review', 'weekly review notes', 'ReadingList',
  'reading list', 'Zoë', 'Zoe', 'ÅNGSTRÖM', 'angstrom', 'Ünïcödé Page', 'naïve bayes', 'Straße', 'İstanbul',
  'Dr. Alice Smith', 'a', 'ab', 'abc', 'A B C', 'foo-bar-baz', 'FooBarBaz', 'foo_bar', '日本語', '日本語 notes',
  '😀 smile', 'x😀y', 'Hello World', 'hello', 'World Hello', 'The Quick Brown Fox Jumps Over The Lazy Dog Again And Again And Again',
  'page 1', 'page 2', 'page 10', 'Page', 'pages', 'PAGE', 'Straße 2', 'ǅ', 'ﬁne', 'Ａｌｉｃｅ'
];

export const ORACLE_SEARCHES = [
  'Alce', 'alice', 'Alice N', 'project', 'atlas log', 'log atlas', 'cafe', 'resume', 'zoe', 'angstrom', 'unicode', 'naive',
  'strasse', 'istanbul', 'dr alice', 'abc', 'a b', 'ab c', 'fbb', 'foo bar', 'nihon', '日本', 'smile', 'x', 'hello world',
  'cafe menu', 'café', 'ÅNGSTRÖM', 'zoë', 'foo bar baz', 'FBB', 'a1', 'p 1', 'jan 1', 'wk rev', 'hello  world', 'x😀', '😀', 'ß',
  'smith dr', 'alice smith', 'the quick', 'again again', 'o', 'a\tb', '\tabc', 'lazy  fox again',
  'world hello', 'lazy fox', 'pg', 'page', 'pge 1', 'Weekly Reveiw', 'reading', 'readinglist', 'fine', 'ALICE', ' alice ',
  'al ice', 'a  b', 'é', 'e', 'qqq', 'jan 2025', '1st', 'review weekly notes'
];

export interface OracleCase {
  search: string;
  results: string[];
  scores: string[];
}

export interface Oracle {
  names: string[];
  /** limit 3, as `suggestPages` asks for */
  limited: OracleCase[];
  /** no limit, to compare the whole order and every score */
  full: OracleCase[];
}

// The options `suggestPages` passes. The threshold is NaN once fuzzysort has read it (see
// rust/src/fuzzy.rs), so it filters nothing; it is kept here so the oracle is the real call.
const run = (search: string, limit: number | undefined): OracleCase => {
  const results = Fuzzysort.go(search, ORACLE_NAMES.map(originalName => ({ originalName })), {
    key: 'originalName',
    ...(limit === undefined ? {} : { limit }),
    threshold: -10000
  });
  return {
    search,
    results: results.map(result => result.obj.originalName),
    // `_score` is internal to fuzzysort and not in its typings; the exact double is what is compared
    scores: results.map(result => String((result as unknown as { _score: number })._score))
  };
};

export function computeOracle(): Oracle {
  return {
    names: ORACLE_NAMES,
    limited: ORACLE_SEARCHES.map(search => run(search, 3)),
    full: ORACLE_SEARCHES.map(search => run(search, undefined))
  };
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMainModule) process.stdout.write(`${JSON.stringify(computeOracle(), null, 1)}\n`);
