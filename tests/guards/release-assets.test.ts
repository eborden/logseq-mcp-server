import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { at, parseWorkflowYaml } from './workflow-yaml.js';

// ADR-0023 (mit-license) says the LICENSE ships with the software. Since the TypeScript server's npm package went (its
// `files` list carried the LICENSE, ADR-0035 Decision 8), the LICENSE ships as an asset of the GitHub Release, beside
// THIRD-PARTY-NOTICES.txt (ADR-0035 Decision 3), and the launcher downloads both next to the binary and checks them
// against SHA256SUMS. This holds the three links of that chain: the repository has the MIT LICENSE, release.yml copies
// it into the release set and lists it in SHA256SUMS, and the draft release uploads it.
//
// The checks are functions of text, so the negative tests below hand them a broken copy and see them fail.

const ROOT = new URL('../../', import.meta.url);
const ASSETS = ['LICENSE', 'THIRD-PARTY-NOTICES.txt'];

/** The `run:` text of the step with this name, with `\` line continuations joined, or '' when there is none. */
function stepRun(workflowSource: string, stepName: string): string {
  const jobs = [...at(parseWorkflowYaml(workflowSource), 'jobs').map.values()];
  for (const job of jobs) {
    for (const step of job.map.get('steps')?.items ?? []) {
      if (step.map.get('name')?.value === stepName) return (step.map.get('run')?.value ?? '').replace(/\\\n\s*/g, ' ');
    }
  }
  return '';
}

/** The assets `gh release create` is given in the draft step: its arguments that start with `dist/`. */
function uploadedAssets(workflowSource: string): string[] {
  const run = stepRun(workflowSource, 'Create the draft release');
  return /\bgh\s+release\s+create\b/.test(run) ? [...run.matchAll(/\bdist\/(\S+)/g)].map(m => m[1]) : [];
}

/** The file names `sha256sum` is given in the step that writes SHA256SUMS. */
function summedFiles(workflowSource: string): string[] {
  const run = stepRun(workflowSource, 'Write SHA256SUMS');
  const line = run.split('\n').find(l => /\bsha256sum\b/.test(l) && l.includes('> SHA256SUMS'));
  return line ? line.replace(/^.*?\bsha256sum\s+/, '').replace(/\s*>\s*SHA256SUMS.*$/, '').split(/\s+/).map(f => f.replace(/"/g, '')) : [];
}

describe('the LICENSE ships as a release asset (ADR-0023, ADR-0035 Decision 3)', () => {
  const workflow = readFileSync(new URL('.github/workflows/release.yml', ROOT), 'utf-8');

  it('the repository has the LICENSE file with the MIT text', () => {
    expect(existsSync(new URL('LICENSE', ROOT))).toBe(true);
    const text = readFileSync(new URL('LICENSE', ROOT), 'utf-8');
    expect(text.split('\n')[0]).toBe('MIT License');
    expect(text).toContain('Permission is hereby granted, free of charge');
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it('release.yml copies LICENSE and the notices into the release set', () => {
    expect(workflow).toMatch(/^\s*cp LICENSE THIRD-PARTY-NOTICES\.txt notices\/$/m);
  });

  it('release.yml lists LICENSE and the notices in SHA256SUMS', () => {
    expect(summedFiles(workflow)).toEqual(expect.arrayContaining(ASSETS));
  });

  it('release.yml uploads LICENSE and the notices with the draft release', () => {
    expect(uploadedAssets(workflow)).toEqual(expect.arrayContaining(ASSETS));
  });

  describe('the checks fail on a broken workflow', () => {
    const upload = (assets: string) =>
      ['jobs:', '  publish:', '    steps:', '      - name: Create the draft release', '        run: |', '          gh release create "v1" \\', `            ${assets}`].join('\n');
    const sums = (files: string) =>
      ['jobs:', '  publish:', '    steps:', '      - name: Write SHA256SUMS', '        run: |', `          LC_ALL=C sha256sum ${files} > SHA256SUMS`].join('\n');

    it('reads the uploaded assets', () => {
      expect(uploadedAssets(upload('dist/logseq-mcp-server-* dist/SHA256SUMS dist/LICENSE dist/THIRD-PARTY-NOTICES.txt'))).toEqual(
        expect.arrayContaining(ASSETS),
      );
    });

    it('sees a LICENSE or a notices file left out of the upload', () => {
      expect(uploadedAssets(upload('dist/logseq-mcp-server-* dist/SHA256SUMS dist/THIRD-PARTY-NOTICES.txt'))).not.toContain('LICENSE');
      expect(uploadedAssets(upload('dist/logseq-mcp-server-* dist/SHA256SUMS dist/LICENSE'))).not.toContain('THIRD-PARTY-NOTICES.txt');
    });

    it('sees a missing upload step, and a step that is not a release create', () => {
      expect(uploadedAssets('jobs:\n  publish:\n    steps:\n      - name: Other\n        run: echo hi')).toEqual([]);
      expect(uploadedAssets(upload('dist/LICENSE').replace('gh release create', 'gh release view'))).toEqual([]);
    });

    it('reads the summed files and sees a file left out of them', () => {
      expect(summedFiles(sums('"a-binary" LICENSE THIRD-PARTY-NOTICES.txt'))).toEqual(['a-binary', 'LICENSE', 'THIRD-PARTY-NOTICES.txt']);
      expect(summedFiles(sums('"a-binary" THIRD-PARTY-NOTICES.txt'))).not.toContain('LICENSE');
    });
  });
});
