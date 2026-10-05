import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import {
  checkAllDocs,
  checkDocsDir,
  formatViolation,
  linesOutsideFences,
  memoryFs,
  nodeFs,
  type RuleCode,
} from '../scripts/docs-format.js';

// Guard for docs/adr/ and docs/business-rules/ (#78). The format is the
// "Format rules" section of each directory's README; the checker lives in
// scripts/docs-format.ts so these self-tests can feed it synthetic trees.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('docs/adr and docs/business-rules follow their format rules', () => {
  const result = checkAllDocs(nodeFs(REPO_ROOT));

  it('has no violations', () => {
    expect(result.violations.map(formatViolation)).toEqual([]);
  });

  // Files are never deleted, so an empty directory means the guard is checking nothing.
  it.each(['adr', 'business-rule'] as const)('found the %s files (the guard is not checking an empty set)', kind => {
    expect(checkDocsDir(nodeFs(REPO_ROOT), kind).stems.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Synthetic fixtures. Every name below is made up.

type Files = Record<string, string>;

function adr(opts: { title: string; status: string; date?: string | null; enforcement?: string; extra?: string }): string {
  const date = opts.date === undefined ? 'Date: 2026-01-01' : opts.date;
  return [
    `# ${opts.title}`,
    '',
    '## Context',
    '',
    'Something forced a choice (#1).',
    '',
    '## Decision',
    '',
    'We chose the new way.',
    '',
    '## Consequences',
    '',
    'Easier and harder things.',
    '',
    '## Status',
    '',
    opts.status,
    ...(date === null ? [] : ['', date]),
    '',
    opts.extra ?? '',
    '## Mechanical enforcement',
    '',
    opts.enforcement ?? '- test: `src/example.test.ts` (pins the new way)',
    '',
  ].join('\n');
}

function rule(opts: { title: string; enforcement?: string; changelog?: string }): string {
  return [
    `# ${opts.title}`,
    '',
    '## Statement',
    '',
    'The tools must never do the bad thing.',
    '',
    '## Rationale',
    '',
    'See [ADR-0002](../adr/0002-new-way.md).',
    '',
    '## Mechanical enforcement',
    '',
    opts.enforcement ?? 'test: `src/example.test.ts`\nreviewer: A new tool does not do the bad thing.',
    '',
    '## Changelog',
    '',
    opts.changelog ?? '| Date | Change | Issue/PR |\n|---|---|---|\n| 2026-01-01 | Introduced. | #2 |',
    '',
  ].join('\n');
}

const ADR_README = `# Architecture Decision Records

See [Format rules](#format-rules) and [the rules](../business-rules/README.md).

## Index

| ADR | Title | Status |
|---|---|---|
| [0001-old-way](0001-old-way.md) | Do it the old way | superseded by 0002-new-way |
| [0002-new-way](0002-new-way.md) | Do it the new way | accepted |

## Format rules

A later table is not the index:

| Status | Meaning |
|---|---|
| \`accepted\` | In force. |

\`\`\`\`markdown
# Template title

## Status

proposed

[not a link](missing.md)
\`\`\`\`
`;

const BR_README = `# Business Rules

## Index

| Rule | Summary |
|---|---|
| [0001-no-bad-thing](0001-no-bad-thing.md) | Never do the bad thing. |
`;

function baseFixture(): Files {
  return {
    'src/example.test.ts': '',
    '.github/workflows/ci.yml': '',
    'docs/adr/README.md': ADR_README,
    'docs/adr/0001-old-way.md': adr({
      title: 'Do it the old way',
      status: 'superseded by 0002-new-way',
      enforcement: 'none-yet: #3 (adds a test)',
    }),
    'docs/adr/0002-new-way.md': adr({ title: 'Do it the new way', status: 'accepted' }),
    'docs/business-rules/README.md': BR_README,
    'docs/business-rules/0001-no-bad-thing.md': rule({ title: 'Never do the bad thing' }),
  };
}

function check(files: Files) {
  return checkAllDocs(memoryFs(files)).violations;
}

describe('docs format guard: a valid tree', () => {
  it('passes the baseline fixture', () => {
    expect(check(baseFixture()).map(formatViolation)).toEqual([]);
  });

  const passing: [string, (f: Files) => void][] = [
    ['ignores non-.md files and subdirectories', f => {
      f['docs/adr/.gitkeep'] = '';
      f['docs/adr/drafts/Not-A-Stem.md'] = 'anything';
    }],
    ['allows extra headings and any heading order', f => {
      f['docs/adr/0002-new-way.md'] = adr({ title: 'Do it the new way', status: 'accepted', extra: '## Notes\n\nMore.\n' });
    }],
    ['allows a missing Date line', f => {
      f['docs/adr/0002-new-way.md'] = adr({ title: 'Do it the new way', status: 'accepted', date: null });
    }],
    ['accepts deprecated', f => {
      f['docs/adr/0002-new-way.md'] = adr({ title: 'Do it the new way', status: 'deprecated' });
      f['docs/adr/README.md'] = ADR_README.replace('| Do it the new way | accepted |', '| Do it the new way | deprecated |');
    }],
    ['ignores prose lines in Mechanical enforcement', f => {
      f['docs/business-rules/0001-no-bad-thing.md'] = rule({
        title: 'Never do the bad thing',
        enforcement: 'The tests below pin it. Not: a tier line.\n\n- test: `src/example.test.ts`\n1. ci: `.github/workflows/ci.yml` (CI)',
      });
    }],
    ['checks a second backticked path but treats other spans as prose', f => {
      f['docs/business-rules/0001-no-bad-thing.md'] = rule({
        title: 'Never do the bad thing',
        enforcement: 'test: `src/example.test.ts` (with `.github/workflows/ci.yml`; pins `ResultMeta` and `a b/c`)',
      });
    }],
    ['ignores tier-like prose outside list items, and list items that are not a tier word', f => {
      f['docs/business-rules/0001-no-bad-thing.md'] = rule({
        title: 'Never do the bad thing',
        enforcement: 'CI: runs on every push.\nTests: see below.\n- tests: plural is prose\n- Unit: not a tier\n\ntest: `src/example.test.ts`',
      });
    }],
    ['accepts none-yet as #N, a full issue URL or a markdown link to one', f => {
      f['docs/business-rules/0001-no-bad-thing.md'] = rule({
        title: 'Never do the bad thing',
        enforcement: [
          'none-yet: #12',
          'none-yet: https://github.com/alice/project-atlas/issues/12',
          'none-yet: [#12](https://github.com/alice/project-atlas/issues/12) (adds a check)',
        ].join('\n'),
      });
    }],
    ['ignores headings, tables and links inside fenced code blocks and code spans', f => {
      f['docs/adr/0002-new-way.md'] = adr({
        title: 'Do it the new way',
        status: 'accepted',
        extra: '```\n# Not a title\n## Status\n[x](nowhere.md)\n```\n\nInline `[y](nowhere.md)` too.\n',
      });
    }],
    ['skips external links and same-file anchors', f => {
      f['docs/adr/0002-new-way.md'] = adr({
        title: 'Do it the new way',
        status: 'accepted',
        extra: '[a](https://example.com/x.md) [b](#status) [c](mailto:alice@example.com)\n',
      });
    }],
  ];
  it.each(passing)('%s', (_name, mutate) => {
    const files = baseFixture();
    mutate(files);
    expect(check(files).map(formatViolation)).toEqual([]);
  });
});

describe('docs format guard: each violation fails', () => {
  const failing: { name: string; rule: RuleCode; file: string; message: RegExp; mutate: (f: Files) => void }[] = [
    {
      name: 'a filename with uppercase letters',
      rule: 'filename',
      file: 'docs/business-rules/0002-Bad-Name.md',
      message: /must match/,
      mutate: f => {
        f['docs/business-rules/0002-Bad-Name.md'] = rule({ title: 'Bad' });
        f['docs/business-rules/README.md'] = BR_README + '| [0002-Bad-Name](0002-Bad-Name.md) | Bad. |\n';
      },
    },
    {
      name: 'a filename with no number',
      rule: 'filename',
      file: 'docs/business-rules/no-number.md',
      message: /must match/,
      mutate: f => {
        f['docs/business-rules/no-number.md'] = rule({ title: 'No number' });
        f['docs/business-rules/README.md'] = BR_README + '| [no-number](no-number.md) | No number. |\n';
      },
    },
    {
      name: 'a duplicate number',
      rule: 'duplicate-number',
      file: 'docs/business-rules/0001-same-number.md',
      message: /number 0001 is shared by 0001-no-bad-thing, 0001-same-number/,
      mutate: f => {
        f['docs/business-rules/0001-same-number.md'] = rule({ title: 'Same number' });
        f['docs/business-rules/README.md'] = BR_README + '| [0001-same-number](0001-same-number.md) | Same. |\n';
      },
    },
    {
      name: 'a missing section',
      rule: 'heading',
      file: 'docs/business-rules/0001-no-bad-thing.md',
      message: /missing "## Rationale"/,
      mutate: f => {
        f['docs/business-rules/0001-no-bad-thing.md'] = f['docs/business-rules/0001-no-bad-thing.md'].replace('## Rationale\n', '');
      },
    },
    {
      name: 'a heading with trailing whitespace',
      rule: 'heading',
      file: 'docs/adr/0002-new-way.md',
      message: /missing "## Decision" \(line \d+ has "## Decision "/,
      mutate: f => {
        f['docs/adr/0002-new-way.md'] = f['docs/adr/0002-new-way.md'].replace('## Decision\n', '## Decision \n');
      },
    },
    {
      name: 'a heading in the wrong case',
      rule: 'heading',
      file: 'docs/adr/0002-new-way.md',
      message: /missing "## Mechanical enforcement" \(line \d+ has "## Mechanical Enforcement"/,
      mutate: f => {
        f['docs/adr/0002-new-way.md'] = f['docs/adr/0002-new-way.md'].replace('## Mechanical enforcement', '## Mechanical Enforcement');
      },
    },
    {
      name: 'a section that appears twice',
      rule: 'heading',
      file: 'docs/adr/0002-new-way.md',
      message: /"## Context" appears 2 times/,
      mutate: f => {
        f['docs/adr/0002-new-way.md'] = adr({ title: 'Do it the new way', status: 'accepted', extra: '## Context\n\nAgain.\n' });
      },
    },
    {
      name: 'a section that exists only inside a code fence',
      rule: 'heading',
      file: 'docs/adr/0002-new-way.md',
      message: /missing "## Consequences"/,
      mutate: f => {
        f['docs/adr/0002-new-way.md'] = f['docs/adr/0002-new-way.md'].replace('## Consequences\n', '```\n## Consequences\n```\n');
      },
    },
    {
      name: 'two # title headings',
      rule: 'title',
      file: 'docs/adr/0002-new-way.md',
      message: /exactly one "# Title" heading, found 2/,
      mutate: f => {
        f['docs/adr/0002-new-way.md'] = adr({ title: 'Do it the new way', status: 'accepted', extra: '# Another title\n' });
      },
    },
    {
      name: 'a dangling supersede',
      rule: 'status',
      file: 'docs/adr/0001-old-way.md',
      message: /superseded by "0009-gone", which is not an ADR/,
      mutate: f => {
        f['docs/adr/0001-old-way.md'] = adr({ title: 'Do it the old way', status: 'superseded by 0009-gone', enforcement: 'none-yet: #3' });
        f['docs/adr/README.md'] = ADR_README.replace('superseded by 0002-new-way', 'superseded by 0009-gone');
      },
    },
    {
      name: 'a supersede by slug instead of the full stem',
      rule: 'status',
      file: 'docs/adr/0001-old-way.md',
      message: /superseded by "new-way", which is not an ADR/,
      mutate: f => {
        f['docs/adr/0001-old-way.md'] = adr({ title: 'Do it the old way', status: 'superseded by new-way', enforcement: 'none-yet: #3' });
        f['docs/adr/README.md'] = ADR_README.replace('superseded by 0002-new-way', 'superseded by new-way');
      },
    },
    {
      name: 'a status outside the vocabulary',
      rule: 'status',
      file: 'docs/adr/0002-new-way.md',
      message: /status line "Accepted" must be exactly one of/,
      mutate: f => {
        f['docs/adr/0002-new-way.md'] = adr({ title: 'Do it the new way', status: 'Accepted' });
      },
    },
    {
      name: 'a malformed Date line',
      rule: 'status',
      file: 'docs/adr/0002-new-way.md',
      message: /date line "Date: 2026-13-01"/,
      mutate: f => {
        f['docs/adr/0002-new-way.md'] = adr({ title: 'Do it the new way', status: 'accepted', date: 'Date: 2026-13-01' });
      },
    },
    {
      name: 'an unindexed file',
      rule: 'index',
      file: 'docs/adr/README.md',
      message: /0003-unlisted\.md has no row in the index/,
      mutate: f => {
        f['docs/adr/0003-unlisted.md'] = adr({ title: 'Unlisted', status: 'proposed' });
      },
    },
    {
      name: 'an index row with no file',
      rule: 'index',
      file: 'docs/business-rules/README.md',
      message: /"0002-ghost" is indexed but 0002-ghost\.md does not exist/,
      mutate: f => {
        f['docs/business-rules/README.md'] = BR_README + '| [0002-ghost](0002-ghost.md) | Ghost. |\n';
      },
    },
    {
      name: 'an index key with backticks',
      rule: 'index',
      file: 'docs/business-rules/README.md',
      message: /first cell "\[`0001-no-bad-thing`\]\(0001-no-bad-thing\.md\)" must be \[<stem>\]\(<stem>\.md\)/,
      mutate: f => {
        f['docs/business-rules/README.md'] = BR_README.replace('[0001-no-bad-thing]', '[`0001-no-bad-thing`]');
      },
    },
    {
      name: 'an index key by slug only',
      rule: 'index',
      file: 'docs/business-rules/README.md',
      message: /"no-bad-thing" is indexed but no-bad-thing\.md does not exist/,
      mutate: f => {
        f['docs/business-rules/README.md'] = BR_README.replace('[0001-no-bad-thing](0001-no-bad-thing.md)', '[no-bad-thing](no-bad-thing.md)');
      },
    },
    {
      name: 'an ADR Title cell that differs from the # heading',
      rule: 'index',
      file: 'docs/adr/README.md',
      message: /Title cell for "0002-new-way" is "Do it the newer way"/,
      mutate: f => {
        f['docs/adr/README.md'] = ADR_README.replace('Do it the new way', 'Do it the newer way');
      },
    },
    {
      name: 'an ADR Status cell that differs from the status line',
      rule: 'index',
      file: 'docs/adr/README.md',
      message: /Status cell for "0002-new-way" is "`accepted`"/,
      mutate: f => {
        f['docs/adr/README.md'] = ADR_README.replace('| Do it the new way | accepted |', '| Do it the new way | `accepted` |');
      },
    },
    {
      name: 'a business rule with an empty Changelog table',
      rule: 'changelog',
      file: 'docs/business-rules/0001-no-bad-thing.md',
      message: /at least one row/,
      mutate: f => {
        f['docs/business-rules/0001-no-bad-thing.md'] = rule({ title: 'Never do the bad thing', changelog: '| Date | Change | Issue/PR |\n|---|---|---|' });
      },
    },
    {
      name: 'a business rule with no Changelog table',
      rule: 'changelog',
      file: 'docs/business-rules/0001-no-bad-thing.md',
      message: /has no table/,
      mutate: f => {
        f['docs/business-rules/0001-no-bad-thing.md'] = rule({ title: 'Never do the bad thing', changelog: 'Introduced in #2.' });
      },
    },
    {
      name: 'a Changelog table with the wrong columns',
      rule: 'changelog',
      file: 'docs/business-rules/0001-no-bad-thing.md',
      message: /columns must be Date, Change, Issue\/PR/,
      mutate: f => {
        f['docs/business-rules/0001-no-bad-thing.md'] = rule({
          title: 'Never do the bad thing',
          changelog: '| Date | Change | PR |\n|---|---|---|\n| 2026-01-01 | Introduced. | #2 |',
        });
      },
    },
    {
      name: 'a missing path',
      rule: 'enforcement',
      file: 'docs/business-rules/0001-no-bad-thing.md',
      message: /test: `src\/missing\.test\.ts` does not exist/,
      mutate: f => {
        f['docs/business-rules/0001-no-bad-thing.md'] = rule({ title: 'Never do the bad thing', enforcement: 'test: `src/missing.test.ts`' });
      },
    },
    {
      name: 'a missing second path on a tier line',
      rule: 'enforcement',
      file: 'docs/business-rules/0001-no-bad-thing.md',
      message: /test: `src\/utils\/nope\.test\.ts` does not exist/,
      mutate: f => {
        f['docs/business-rules/0001-no-bad-thing.md'] = rule({
          title: 'Never do the bad thing',
          enforcement: 'test: `src/example.test.ts`, `src/utils/nope.test.ts`',
        });
      },
    },
    {
      name: 'a path that is a directory, not a file',
      rule: 'enforcement',
      file: 'docs/business-rules/0001-no-bad-thing.md',
      message: /ci: `\.github\/workflows` does not exist/,
      mutate: f => {
        f['docs/business-rules/0001-no-bad-thing.md'] = rule({ title: 'Never do the bad thing', enforcement: 'ci: `.github/workflows`' });
      },
    },
    {
      name: 'a path that is not backticked',
      rule: 'enforcement',
      file: 'docs/business-rules/0001-no-bad-thing.md',
      message: /must start with a backticked repo-relative path/,
      mutate: f => {
        f['docs/business-rules/0001-no-bad-thing.md'] = rule({ title: 'Never do the bad thing', enforcement: 'test: src/example.test.ts' });
      },
    },
    {
      name: 'a bad tier: a capitalised tier in a list item',
      rule: 'enforcement',
      file: 'docs/business-rules/0001-no-bad-thing.md',
      message: /"Test: `src\/example\.test\.ts`" is not a tier line: write the tier as plain lowercase "test: <reference>"/,
      mutate: f => {
        f['docs/business-rules/0001-no-bad-thing.md'] = rule({
          title: 'Never do the bad thing',
          enforcement: '- Test: `src/example.test.ts`\n- reviewer: Checked by hand.',
        });
      },
    },
    {
      name: 'a bad tier: a bold tier in a list item',
      rule: 'enforcement',
      file: 'docs/business-rules/0001-no-bad-thing.md',
      message: /"\*\*test:\*\* `src\/example\.test\.ts`" is not a tier line: write the tier as plain lowercase/,
      mutate: f => {
        f['docs/business-rules/0001-no-bad-thing.md'] = rule({
          title: 'Never do the bad thing',
          enforcement: '- **test:** `src/example.test.ts`\n- reviewer: Checked by hand.',
        });
      },
    },
    {
      name: 'a bad tier: "none yet" with a space in a list item',
      rule: 'enforcement',
      file: 'docs/business-rules/0001-no-bad-thing.md',
      message: /write the tier as plain lowercase "none-yet: <reference>"/,
      mutate: f => {
        f['docs/business-rules/0001-no-bad-thing.md'] = rule({
          title: 'Never do the bad thing',
          enforcement: '- None yet: #3\n- reviewer: Checked by hand.',
        });
      },
    },
    {
      name: 'a tier with no space after the colon',
      rule: 'enforcement',
      file: 'docs/business-rules/0001-no-bad-thing.md',
      message: /"test:`src\/example\.test\.ts`" is not a tier line: expected "test: <reference>" \(a space after the colon/,
      mutate: f => {
        f['docs/business-rules/0001-no-bad-thing.md'] = rule({
          title: 'Never do the bad thing',
          enforcement: 'test:`src/example.test.ts`\nreviewer: Checked by hand.',
        });
      },
    },
    {
      name: 'a tier with an empty reference',
      rule: 'enforcement',
      file: 'docs/business-rules/0001-no-bad-thing.md',
      message: /"reviewer:" is not a tier line: expected "reviewer: <reference>" \(a space after the colon, and a non-empty reference\)/,
      mutate: f => {
        f['docs/business-rules/0001-no-bad-thing.md'] = rule({
          title: 'Never do the bad thing',
          enforcement: 'test: `src/example.test.ts`\nreviewer:',
        });
      },
    },
    {
      name: 'no tier line at all (the template placeholder left in)',
      rule: 'enforcement',
      file: 'docs/adr/0002-new-way.md',
      message: /needs at least one "<tier>: <reference>" line/,
      mutate: f => {
        f['docs/adr/0002-new-way.md'] = adr({ title: 'Do it the new way', status: 'accepted', enforcement: '<tier>: <reference>' });
      },
    },
    {
      name: 'none-yet with no issue link',
      rule: 'enforcement',
      file: 'docs/adr/0001-old-way.md',
      message: /none-yet: must link an issue/,
      mutate: f => {
        f['docs/adr/0001-old-way.md'] = adr({
          title: 'Do it the old way',
          status: 'superseded by 0002-new-way',
          enforcement: 'none-yet: someone should add a test',
        });
      },
    },
    {
      name: 'a dangling relative link in a doc',
      rule: 'link',
      file: 'docs/business-rules/0001-no-bad-thing.md',
      message: /link "\.\.\/adr\/0009-gone\.md" does not resolve/,
      mutate: f => {
        f['docs/business-rules/0001-no-bad-thing.md'] = f['docs/business-rules/0001-no-bad-thing.md'].replace(
          '../adr/0002-new-way.md',
          '../adr/0009-gone.md',
        );
      },
    },
    {
      name: 'a dangling relative link in a README',
      rule: 'link',
      file: 'docs/adr/README.md',
      message: /link "\.\.\/business-rule\/README\.md" does not resolve/,
      mutate: f => {
        f['docs/adr/README.md'] = ADR_README.replace('../business-rules/README.md', '../business-rule/README.md');
      },
    },
    {
      name: 'a link that leaves the repo',
      rule: 'link',
      file: 'docs/adr/0002-new-way.md',
      message: /points outside the repo/,
      mutate: f => {
        f['docs/adr/0002-new-way.md'] = adr({ title: 'Do it the new way', status: 'accepted', extra: '[x](../../../elsewhere.md)\n' });
      },
    },
    {
      name: 'a missing README',
      rule: 'readme',
      file: 'docs/business-rules/README.md',
      message: /README\.md is missing/,
      mutate: f => {
        delete f['docs/business-rules/README.md'];
      },
    },
  ];

  it.each(failing)('fails on $name', ({ rule: code, file, message, mutate }) => {
    const files = baseFixture();
    mutate(files);
    const violations = check(files);
    expect(violations).toContainEqual(expect.objectContaining({ rule: code, file, message: expect.stringMatching(message) }));
  });
});

describe('linesOutsideFences', () => {
  it('drops fenced lines, keeps line numbers, and needs a matching fence to close', () => {
    const text = ['a', '````markdown', '```', 'inside', '```', '````', 'b', '~~~', 'c'].join('\n');
    expect(linesOutsideFences(text)).toEqual([
      { n: 1, text: 'a' },
      { n: 7, text: 'b' },
    ]);
  });
});
