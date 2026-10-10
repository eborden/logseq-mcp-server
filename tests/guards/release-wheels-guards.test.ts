import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { at, listOf, parseWorkflowYaml, type YamlNode } from './workflow-yaml.js';

// ADR-0036: the PyPI wheels ride on the release. release.yml builds them from the gated binaries in a read-only job, and
// its last job checksums, attests and attaches them, so pypi.yml uploads exactly the files of the release. The rules of
// release.yml that ADR-0035 sets (manual, main-only, drafts only, one write job) are held by release-workflow-guards.
//
// The checks are functions of the workflow's text, so the negative tests below can hand them a broken copy and see
// them fail: a guard that has never been seen to fail proves nothing.

const source = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf-8');

const WHEEL_NAMES = [
  'logseq_mcp_server-${VERSION}-py3-none-macosx_11_0_arm64.whl',
  'logseq_mcp_server-${VERSION}-py3-none-macosx_10_12_x86_64.whl',
  'logseq_mcp_server-${VERSION}-py3-none-manylinux_2_17_x86_64.musllinux_1_2_x86_64.whl',
];

/** Workflow text without comment-only lines, with `\` line continuations joined: what a shell would read. */
function commandText(text: string): string {
  return text
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n')
    .replace(/\\\n\s*/g, ' ');
}

const jobsOf = (workflow: YamlNode) => new Map(at(workflow, 'jobs').map.entries());
const stepsOf = (job: YamlNode) => job.map.get('steps')?.items ?? [];
const needsOf = (job: YamlNode): string[] => {
  const needs = job.map.get('needs');
  if (!needs) return [];
  return needs.items.length > 0 || needs.value.startsWith('[') ? listOf(needs) : [needs.value];
};
const runsOf = (job: YamlNode) => stepsOf(job).map(step => commandText(step.map.get('run')?.value ?? '')).join('\n');

/** What ADR-0036 says release.yml must do for the wheels. An empty list means it does. */
function wheelProblems(text: string): string[] {
  const problems: string[] = [];
  const jobs = jobsOf(parseWorkflowYaml(text));
  const wheels = jobs.get('wheels');
  const release = jobs.get('release');
  if (!wheels || !release) return ['release.yml has no "wheels" or no "release" job'];

  if (JSON.stringify(needsOf(wheels)) !== '["preflight","build","notices"]') problems.push(`the wheels job needs ${JSON.stringify(needsOf(wheels))}, not the preflight, every leg and the notices`);
  if (wheels.map.has('permissions')) problems.push('the wheels job sets permissions: it runs with the read-only token');
  const runs = runsOf(wheels);
  if (!/python3 -I -m unittest discover -s scripts\/pypi/.test(runs)) problems.push("the wheels job does not run the wheel builder's tests");
  if (!/python3 -I scripts\/pypi\/build_wheels\.py --version "\$VERSION" --assets assets --readme pypi\/README\.md --out wheels/.test(runs)) problems.push('the wheels job does not run build_wheels.py on the downloaded assets');
  if (!/cmp "\$\{RUNNER_TEMP\}\/check\/bin\/logseq-mcp-server" "assets\/logseq-mcp-server-\$\{VERSION\}-x86_64-unknown-linux-musl"/.test(runs)) problems.push('the wheels job does not check that the installed executable is the gated binary');
  // Every wheel, not only the one the runner can install, carries the binary of the target its tag names
  const carries = stepsOf(wheels).find(step => step.map.get('name')?.value === 'Check that each wheel carries its own binary');
  const carriesRun = carries?.map.get('run')?.value ?? '';
  if (!carries || !/zipfile\.ZipFile/.test(carriesRun) || !/sys\.exit\(1 if bad else 0\)/.test(carriesRun)) problems.push('the wheels job does not compare the binary inside every wheel with its target\'s asset');
  for (const [tag, target] of [
    ['macosx_11_0_arm64', 'aarch64-apple-darwin'],
    ['macosx_10_12_x86_64', 'x86_64-apple-darwin'],
    ['manylinux_2_17_x86_64.musllinux_1_2_x86_64', 'x86_64-unknown-linux-musl'],
  ]) {
    if (!carriesRun.includes(`"${tag}": "${target}"`)) problems.push(`the per-wheel binary check does not pair ${tag} with ${target}`);
  }
  if (!/test "\$\(find \. -type f \| wc -l\)" -eq 3/.test(runs)) problems.push('the wheels job does not check that the wheel set is exactly three files');
  for (const wheel of WHEEL_NAMES) if (!runs.includes(`test -f "${wheel}"`)) problems.push(`the wheels job does not check that ${wheel} was built`);
  if (/\b(?:cargo|rustc|npm)\b/.test(runs) || /\bpip3?\s+install\b(?![^\n]*--no-index)/.test(runs) || /-m pip install\b(?![^\n]*--no-index)/.test(runs)) problems.push('the wheels job builds Rust or installs a package from an index: the wheels carry the gated binaries and the job installs nothing');
  const uploads = stepsOf(wheels).filter(step => step.map.get('uses')?.value.startsWith('actions/upload-artifact@'));
  if (!uploads.some(step => step.map.get('with')?.map.get('name')?.value === 'wheels')) problems.push('the wheels job does not upload an artifact named wheels');

  const releaseRuns = runsOf(release);
  const sumsLine = releaseRuns.split('\n').find(line => /\bsha256sum\b/.test(line) && line.includes('> SHA256SUMS')) ?? '';
  for (const wheel of WHEEL_NAMES) {
    if (!sumsLine.includes(`"${wheel}"`)) problems.push(`SHA256SUMS does not list ${wheel}`);
    if (!releaseRuns.includes(`test -f "${wheel}"`)) problems.push(`the release job does not check that ${wheel} is there`);
  }
  if (!/test "\$\(find \. -type f \| wc -l\)" -eq 8/.test(releaseRuns)) problems.push('the release job does not check that the release set is exactly eight files before SHA256SUMS');
  const attest = stepsOf(release).find(step => step.map.get('uses')?.value.startsWith('actions/attest@'));
  const subjects = (attest?.map.get('with')?.map.get('subject-path')?.value ?? '').split('\n').map(line => line.trim());
  for (const subject of ['dist/logseq-mcp-server-*', 'dist/*.whl']) if (!subjects.includes(subject)) problems.push(`the attestation does not cover ${subject}`);
  const create = releaseRuns.split('\n').find(line => /\bgh\s+release\s+create\b/.test(line)) ?? '';
  if (!/\sdist\/\*\.whl(?:\s|$)/.test(create)) problems.push('the draft release is not given the wheels (dist/*.whl)');
  return problems;
}

describe('ADR-0036: release.yml builds the PyPI wheels and attaches them to the release', () => {
  const problems = (text: string) => wheelProblems(text).join('\n');

  it('holds every rule', () => {
    expect(wheelProblems(source)).toEqual([]);
  });

  describe('fails when it is broken', () => {
    /** The source with `needle` replaced, and a check that it was there, so a rewritten workflow can't make a case vacuous. */
    const changed = (needle: string, replacement: string) => {
      expect(source.split(needle).length, `release.yml no longer holds ${JSON.stringify(needle)}`).toBe(2);
      return source.replace(needle, replacement);
    };

    it('leaves a wheel out of SHA256SUMS', () => {
      const broken = changed(' "logseq_mcp_server-${VERSION}-py3-none-manylinux_2_17_x86_64.musllinux_1_2_x86_64.whl" > SHA256SUMS', ' > SHA256SUMS');
      expect(problems(broken)).toMatch(/SHA256SUMS does not list .*manylinux/);
    });

    it('does not attest the wheels', () => {
      expect(problems(changed('            dist/logseq-mcp-server-*\n            dist/*.whl\n', '            dist/logseq-mcp-server-*\n'))).toMatch(/attestation does not cover dist\/\*\.whl/);
    });

    it('does not attest the binaries', () => {
      expect(problems(changed('            dist/logseq-mcp-server-*\n            dist/*.whl\n', '            dist/*.whl\n'))).toMatch(/attestation does not cover dist\/logseq-mcp-server-\*/);
    });

    it('does not attach the wheels to the draft release', () => {
      expect(problems(changed(' dist/THIRD-PARTY-NOTICES.txt dist/*.whl\n', ' dist/THIRD-PARTY-NOTICES.txt\n'))).toMatch(/draft release is not given the wheels/);
    });

    it('lets the release set grow past eight files unchecked', () => {
      expect(problems(changed('          test "$(find . -type f | wc -l)" -eq 8\n', ''))).toMatch(/exactly eight files/);
    });

    it('builds the wheels without the builder, or without its tests', () => {
      expect(problems(changed('        run: python3 -I scripts/pypi/build_wheels.py --version "$VERSION" --assets assets --readme pypi/README.md --out wheels\n', '        run: echo skipped\n'))).toMatch(/does not run build_wheels\.py/);
      expect(problems(changed('        run: python3 -I -m unittest discover -s scripts/pypi\n', '        run: echo skipped\n'))).toMatch(/does not run the wheel builder's tests/);
    });

    it('stops checking that the installed executable is the gated binary', () => {
      expect(problems(changed('          cmp "${RUNNER_TEMP}/check/bin/logseq-mcp-server" "assets/logseq-mcp-server-${VERSION}-x86_64-unknown-linux-musl"\n', ''))).toMatch(/installed executable is the gated binary/);
    });

    it('stops comparing every wheel with its binary, or pairs a tag with the wrong target', () => {
      expect(problems(changed('      - name: Check that each wheel carries its own binary\n', '      - name: Check something else\n'))).toMatch(/does not compare the binary inside every wheel/);
      expect(problems(changed('          sys.exit(1 if bad else 0)\n', '          sys.exit(0)\n'))).toMatch(/does not compare the binary inside every wheel/);
      expect(problems(changed('"macosx_11_0_arm64": "aarch64-apple-darwin"', '"macosx_11_0_arm64": "x86_64-apple-darwin"'))).toMatch(/does not pair macosx_11_0_arm64 with aarch64-apple-darwin/);
    });

    it('stops checking the wheel set', () => {
      expect(problems(changed('          test "$(find . -type f | wc -l)" -eq 3\n', ''))).toMatch(/exactly three files/);
    });

    it('rebuilds Rust or installs from an index in the wheels job', () => {
      expect(problems(changed('      - name: Build the wheels\n', '      - name: Rebuild\n        run: cargo build --release\n      - name: Build the wheels\n'))).toMatch(/builds Rust or installs a package/);
      expect(problems(changed('          python3 -m venv "${RUNNER_TEMP}/check"\n', '          python3 -m venv "${RUNNER_TEMP}/check"\n          "${RUNNER_TEMP}/check/bin/python" -m pip install requests\n'))).toMatch(/builds Rust or installs a package/);
    });

    it('lets the wheels job skip a leg, or give itself a token', () => {
      expect(problems(changed('    name: PyPI wheels\n    needs: [preflight, build, notices]\n', '    name: PyPI wheels\n    needs: [preflight, notices]\n'))).toMatch(/the wheels job needs/);
      expect(problems(changed('    name: PyPI wheels\n', '    name: PyPI wheels\n    permissions:\n      contents: read\n'))).toMatch(/sets permissions/);
    });

    it('does not upload the wheels as an artifact', () => {
      expect(problems(changed('          name: wheels\n', '          name: other\n'))).toMatch(/artifact named wheels/);
    });
  });
});
