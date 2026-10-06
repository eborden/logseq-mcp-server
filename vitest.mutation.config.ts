import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

// The unit suite for mutation runs (ADR-0026, #204). StrykerJS reads this file through
// stryker.config.json. It is vitest.config.ts minus the tests that check layout, wording or
// docs rather than behaviour. They keep running in the unit-test job; here they only add
// transform time and noise. The spike found they decide about 0.2% of kills.
//
// Adding or removing a pattern changes the measured scope: see ADR-0026 (a PR that edits this
// list needs the `mutation-baseline-change` label and the maintainer's OK once #205 lands).
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [
        // Stryker's sandbox and report folders (tempDirName in stryker.config.json): a copy of the
        // suite must never be collected as tests.
        '**/.stryker-tmp/**',
        // ADR and business-rule guards: file layout, repo hygiene, workflows, docs and metadata.
        'src/adr-*.test.ts',
        'src/docs-format.test.ts',
        'src/github-templates.test.ts',
        'src/integration-guard.test.ts',
        'src/no-stdout.test.ts',
        'src/package-metadata.test.ts',
        'src/repo-hygiene.test.ts',
        'src/response-parsing-guard.test.ts',
        'src/version.test.ts',
        // Guards over how tools are listed and what they print (snapshot, schema coverage, no layout whitespace).
        'src/tool-list.test.ts',
        'src/index.args.guard.test.ts',
        'src/index.minified.test.ts',
        // Tests of committed fixtures, scripts and skills. They read files outside src/, which the
        // sandbox copy doesn't have in the same shape, and none of them tests a file Stryker mutates.
        'src/check-terseness.test.ts',
        'src/fixture-graph.test.ts',
        'src/fixture-hub.test.ts',
        'src/logseq-instance*.test.ts',
        // The tests of the CI mutation job itself: they read the workflows, stryker.config.json and
        // scripts/mutation-ci.ts, none of which is mutated, and incremental mode can't see edits to them.
        'src/mutation-ci.test.ts',
      ],
    },
  }),
);
