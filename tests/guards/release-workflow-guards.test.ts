import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { at, jobCondition, listOf, parseWorkflowYaml, triggers, type YamlNode } from './workflow-yaml.js';

// Guards for ADR-0035 (native-binary-release-on-github-releases), which carries ADR-0017's rule over to the release
// workflow (#418): a release is started by the maintainer by hand, from main, and a run defaults to a dry run. The
// workflow creates only a DRAFT release, so publishing (and the tag that comes with it) is a second, deliberate click.
//
// The checks are functions of the workflow's text, so the negative tests below can hand them a broken copy and see
// them fail: a guard that has never been seen to fail proves nothing.

const WORKFLOWS_DIR = new URL('../../.github/workflows/', import.meta.url);
const readWorkflow = (name: string) => readFileSync(new URL(name, WORKFLOWS_DIR), 'utf-8');

// Exactly this, on every job: no `&&` tail. A status function (`always()`, `!cancelled()`, `failure()`) after it would
// let the last job run past a failed leg, and an `||` would open the gate.
const MAIN_GATE = /^github\.ref == 'refs\/heads\/main'$/;
const STATUS_FUNCTION = /\b(?:always|cancelled|failure|success)\s*\(/;
// A release or tag command in any flag order: `gh release create`, `gh -R x release create`, `gh --repo x release edit`
const GH_RELEASE = (verbs: string) => new RegExp(`\\bgh\\b[^\\n]*\\brelease\\s+(?:${verbs})\\b`);
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;
const WRITE_PERMISSIONS = ['contents', 'id-token', 'attestations'];
// The one step that may end in `|| true`: it only prints, and the exemption holds for exactly this script, so a later
// edit can't put other commands under the name.
const SIGNATURE_STEP = 'Show the macOS signature';
const SIGNATURE_RUN = 'codesign --display --verbose=2 "dist/logseq-mcp-server-${VERSION}-${TARGET}" 2>&1 || true';

/** Workflow text without comment-only lines, with `\` line continuations joined: what a shell would read. */
function commandText(source: string): string {
  return source
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n')
    .replace(/\\\n\s*/g, ' ');
}

const jobsOf = (workflow: YamlNode) => [...at(workflow, 'jobs').map.entries()];
const stepsOf = (job: YamlNode) => job.map.get('steps')?.items ?? [];
const needsOf = (job: YamlNode): string[] => (job.map.has('needs') ? listOfOrScalar(job.map.get('needs')!) : []);
const listOfOrScalar = (node: YamlNode) => (node.items.length > 0 || node.value.startsWith('[') ? listOf(node) : [node.value]);

/**
 * Lines that create or change a release or a tag, in any workflow. `gh release create` is the one command release.yml
 * itself may use (its own guard below holds it to --draft and to a real run); everything else belongs to the maintainer
 * on the Releases page.
 */
function releaseOrTagHits(name: string, source: string, options: { allowReleaseCreate: boolean }): string[] {
  const hits: string[] = [];
  const text = commandText(source);
  const rules: [RegExp, string][] = [
    [GH_RELEASE('edit|upload|delete'), 'gh release edit, upload or delete'],
    [/\b(?:curl|wget)\b[^\n]*api\.github\.com[^\n]*(?:releases|git\/refs|git\/tags?\b)/, 'curl or wget to the releases or refs API'],
    [/\bgit\s+(?:tag|push)\b/, 'git tag or git push'],
    [
      /\buses:\s*['"]?(?:softprops\/action-gh-release|actions\/create-release|actions\/upload-release-asset|ncipollo\/release-action|marvinpinto\/action-automatic-releases|svenstaro\/upload-release-action|mathieudutour\/github-tag-action|anothrNick\/github-tag-action|ad-m\/github-push-action)\b/,
      'a release, tag or push action',
    ],
    [/\bcontents:\s*write\b/, 'contents: write'],
  ];
  if (!options.allowReleaseCreate) rules.unshift([GH_RELEASE('create'), 'gh release create']);
  text.split('\n').forEach((line, i) => {
    for (const [pattern, what] of rules) if (pattern.test(line)) hits.push(`${name}: ${what} (${line.trim()}) [${i + 1}]`);
    // A write through `gh api` to the releases, tags or refs endpoints
    const writes = /(?:^|\s)(?:-X|--method|-f|-F|--field|--raw-field|--input)(?:\s|=|$)/.test(line);
    if (/\bgh\s+api\b/.test(line) && writes && /releases|git\/refs|git\/tags?\b/.test(line)) hits.push(`${name}: gh api write to releases or refs (${line.trim()}) [${i + 1}]`);
  });
  return hits;
}

/** Everything ADR-0035 and #418 say release.yml must hold. An empty list means it holds. */
function releaseWorkflowProblems(source: string): string[] {
  const problems: string[] = [];
  const workflow = parseWorkflowYaml(source);
  const jobs = jobsOf(workflow);

  // Manual only
  if (JSON.stringify(triggers(workflow)) !== '["workflow_dispatch"]') problems.push(`triggers are ${JSON.stringify(triggers(workflow))}, not only workflow_dispatch`);
  const inputs = at(workflow, 'on', 'workflow_dispatch', 'inputs');
  const dryRun = inputs.map.get('dry_run');
  if (!dryRun || dryRun.map.get('type')?.value !== 'boolean' || dryRun.map.get('default')?.value !== 'true') problems.push('dry_run is not a boolean input that defaults to true');
  const version = inputs.map.get('version');
  if (!version || version.map.get('required')?.value !== 'true') problems.push('version is not a required input');

  // Main only: every job, with no `||` to open the gate
  if (jobs.length === 0) problems.push('no jobs');
  for (const [name, job] of jobs) {
    if (!MAIN_GATE.test(jobCondition(job) ?? '')) problems.push(`job "${name}" is not gated to exactly refs/heads/main`);
  }

  // Least privilege: read at the top, and exactly one job, the last, with write and the attestation permissions
  const top = workflow.map.get('permissions');
  if (!top || top.map.size !== 1 || top.map.get('contents')?.value !== 'read') problems.push('the workflow-level permissions are not only contents: read');
  const writers = jobs.filter(([, job]) => [...(job.map.get('permissions')?.map.values() ?? [])].some(p => p.value === 'write')).map(([name]) => name);
  if (writers.length !== 1) problems.push(`expected exactly one job with a write permission, found ${JSON.stringify(writers)}`);
  else {
    const lastName = writers[0];
    const lastJob = jobs.find(([name]) => name === lastName)![1];
    for (const [name] of jobs) {
      if (name !== lastName && !needsOf(lastJob).includes(name)) problems.push(`the write job "${lastName}" does not need "${name}", so it could run past a failed leg`);
    }
    for (const [name, job] of jobs) {
      if (needsOf(job).includes(lastName)) problems.push(`job "${name}" needs the write job "${lastName}", which has to be last`);
    }
    const permissions = lastJob.map.get('permissions');
    for (const key of WRITE_PERMISSIONS) if (permissions?.map.get(key)?.value !== 'write') problems.push(`the write job lacks ${key}: write`);
    for (const key of permissions?.map.keys() ?? []) if (!WRITE_PERMISSIONS.includes(key)) problems.push(`the write job holds a permission it should not: ${key}`);
  }
  for (const [name, job] of jobs) {
    if (!writers.includes(name) && job.map.has('permissions')) problems.push(`job "${name}" sets its own permissions; only the write job may`);
  }

  // Every action pinned by commit SHA, with its version in a comment
  const steps = jobs.flatMap(([, job]) => stepsOf(job));
  for (const step of steps) {
    const uses = step.map.get('uses')?.value;
    if (uses !== undefined && !PINNED_ACTION.test(uses)) problems.push(`action "${uses}" is not pinned by a 40-character commit SHA`);
  }
  for (const line of commandText(source).split('\n')) {
    const uses = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
    if (uses && !/^\s+# v\d/.test(uses[2])) problems.push(`action "${uses[1]}" has no version comment`);
  }

  // Inputs and matrix values reach a shell only through env:, never inside the script text
  for (const step of steps) {
    const run = step.map.get('run')?.value;
    if (run !== undefined && run.includes('${{')) problems.push(`a run script holds an expression: ${run.split('\n').find(l => l.includes('${{'))!.trim()}`);
  }

  // A red leg must stop the run: nothing may turn a failure into a pass or run a step past one
  for (const line of commandText(source).split('\n')) {
    if (/\bcontinue-on-error\b/.test(line)) problems.push(`continue-on-error: ${line.trim()}`);
  }
  for (const [name, job] of jobs) {
    if (job.map.has('uses')) {
      const uses = job.map.get('uses')!.value;
      if (!PINNED_ACTION.test(uses)) problems.push(`job "${name}" calls "${uses}", which is not pinned by a 40-character commit SHA`);
    }
    for (const step of stepsOf(job)) {
      const label = `step "${step.map.get('name')?.value ?? step.map.get('uses')?.value ?? step.line}" of job "${name}"`;
      if (STATUS_FUNCTION.test(step.map.get('if')?.value ?? '')) problems.push(`${label} has a status function in its if:`);
      if (step.map.has('shell')) problems.push(`${label} sets shell:, which can drop the fail-fast flags`);
      const run = commandText(step.map.get('run')?.value ?? '');
      if (/\bset\s+\+(?:e|o\s+errexit)\b/.test(run)) problems.push(`${label} turns off errexit`);
      // The one exception: the codesign display, which only prints and exits non-zero for an unsigned x86_64 binary
      if (/\|\|\s*(?:true|:|exit\s+0)(?:\s|;|$)/.test(run) && !(step.map.get('name')?.value === SIGNATURE_STEP && (step.map.get('run')?.value ?? '').trim() === SIGNATURE_RUN)) problems.push(`${label} swallows a failure with || true`);
    }
  }

  // Only a draft, only on a real run
  const text = commandText(source);
  const creates = text.split('\n').filter(line => GH_RELEASE('create').test(line));
  if (creates.length !== 1) problems.push(`expected one gh release create, found ${creates.length}`);
  for (const line of creates) {
    if (!/(?:^|\s)--draft(?:\s|$)/.test(line)) problems.push('gh release create has no --draft');
    if (/--draft=/.test(line)) problems.push('gh release create sets --draft to a value');
  }
  for (const step of steps) {
    const run = step.map.get('run')?.value ?? '';
    const uses = step.map.get('uses')?.value ?? '';
    if (GH_RELEASE('create').test(commandText(run)) || uses.startsWith('actions/attest@')) {
      if (!/^\$\{\{\s*!inputs\.dry_run\s*\}\}$/.test(step.map.get('if')?.value ?? '')) problems.push(`the step "${step.map.get('name')?.value ?? uses}" does not run only when dry_run is off`);
    }
  }
  problems.push(...releaseOrTagHits('release.yml', source, { allowReleaseCreate: true }).filter(hit => !hit.includes('contents: write')));
  return problems;
}

describe('ADR-0035: release.yml is manual, main-only, dry-run by default and drafts only', () => {
  const source = readWorkflow('release.yml');

  it('holds every rule', () => {
    expect(releaseWorkflowProblems(source)).toEqual([]);
  });

  it('triggers on workflow_dispatch and nothing else', () => {
    expect(triggers(parseWorkflowYaml(source))).toEqual(['workflow_dispatch']);
  });

  it('has a boolean dry_run input that defaults to true', () => {
    const dryRun = at(parseWorkflowYaml(source), 'on', 'workflow_dispatch', 'inputs', 'dry_run');
    expect(at(dryRun, 'type').value).toBe('boolean');
    expect(at(dryRun, 'default').value).toBe('true');
  });

  it('gates every job to refs/heads/main', () => {
    const jobs = jobsOf(parseWorkflowYaml(source));
    expect(jobs.length).toBeGreaterThan(0);
    for (const [name, job] of jobs) expect(jobCondition(job) ?? '(no if: condition)', `job "${name}"`).toMatch(MAIN_GATE);
  });

  it('builds the three targets of ADR-0035 Decision 1, each on its own runner', () => {
    const build = at(parseWorkflowYaml(source), 'jobs', 'build');
    const legs = at(build, 'strategy', 'matrix', 'include').items.map(leg => `${at(leg, 'target').value} on ${at(leg, 'os').value}`);
    expect(legs).toEqual([
      'aarch64-apple-darwin on macos-latest',
      'x86_64-apple-darwin on macos-15-intel',
      'x86_64-unknown-linux-musl on ubuntu-latest',
    ]);
    expect(at(build, 'strategy', 'fail-fast').value, 'a dry run has to show the result of every leg').toBe('false');
  });

  it('runs the parity test, its self-check and the release unit tests on each leg, against that target', () => {
    const scripts = stepsOf(at(parseWorkflowYaml(source), 'jobs', 'build')).flatMap(step => (step.map.get('run')?.value ?? '').split('\n'));
    expect(scripts).toContain('cargo build --release --locked --target "$TARGET"');
    expect(scripts).toContain('cargo test --release --locked --target "$TARGET" --test parity --test parity_self_check');
    expect(scripts).toContain('cargo test --release --locked --target "$TARGET" --lib');
  });

  describe('fails when it is broken', () => {
    /** The source with `needle` replaced, and a check that it was there, so a rewritten workflow can't make a case vacuous. */
    const changed = (needle: string, replacement: string) => {
      expect(source.split(needle).length, `release.yml no longer holds ${JSON.stringify(needle)}`).toBe(2);
      return source.replace(needle, replacement);
    };

    it('gains a push trigger', () => {
      const broken = changed('on:\n  workflow_dispatch:', 'on:\n  push:\n    tags: [v*]\n  workflow_dispatch:');
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/not only workflow_dispatch/);
    });

    it('gains a pull_request or schedule trigger', () => {
      for (const event of ['pull_request:\n    branches: [main]', 'schedule:\n    - cron: "0 0 * * *"']) {
        const broken = changed('on:\n  workflow_dispatch:', `on:\n  ${event}\n  workflow_dispatch:`);
        expect(releaseWorkflowProblems(broken).join('\n'), event).toMatch(/not only workflow_dispatch/);
      }
    });

    it('loses its main gate on a job', () => {
      const broken = changed("    name: Licence notices\n    needs: preflight\n    if: github.ref == 'refs/heads/main'\n", '    name: Licence notices\n    needs: preflight\n');
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/job "notices" is not gated to exactly refs\/heads\/main/);
    });

    it('opens its main gate with an ||', () => {
      const broken = changed("    name: Licence notices\n    needs: preflight\n    if: github.ref == 'refs/heads/main'\n", "    name: Licence notices\n    needs: preflight\n    if: github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'\n");
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/job "notices" is not gated/);
    });

    it('gates to another branch', () => {
      const broken = changed("    name: Checksums, attestation and draft release\n    needs: [preflight, build, notices]\n    if: github.ref == 'refs/heads/main'\n", "    name: Checksums, attestation and draft release\n    needs: [preflight, build, notices]\n    if: github.ref == 'refs/heads/feature/rust-spike'\n");
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/job "release" is not gated/);
    });

    const releaseGate = "    name: Checksums, attestation and draft release\n    needs: [preflight, build, notices]\n    if: github.ref == 'refs/heads/main'\n";

    it('adds a status function to a job gate, so the last job could run past a failed leg', () => {
      for (const tail of ['always()', '!cancelled()', 'failure()', 'success() || always()']) {
        const broken = changed(releaseGate, releaseGate.replace("'refs/heads/main'", `'refs/heads/main' && ${tail}`));
        expect(releaseWorkflowProblems(broken).join('\n'), tail).toMatch(/job "release" is not gated to exactly/);
      }
    });

    it('puts a status function in a step if', () => {
      const broken = changed('      - name: Write SHA256SUMS\n', "      - name: Write SHA256SUMS\n        if: ${{ always() }}\n");
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/status function in its if:/);
    });

    it('sets continue-on-error on a step or a job', () => {
      const onStep = changed('      - name: Parity test and its self-check\n', '      - name: Parity test and its self-check\n        continue-on-error: true\n');
      expect(releaseWorkflowProblems(onStep).join('\n')).toMatch(/continue-on-error/);
      const onJob = changed('    name: Build and gate (${{ matrix.target }})\n', '    name: Build and gate (${{ matrix.target }})\n    continue-on-error: true\n');
      expect(releaseWorkflowProblems(onJob).join('\n')).toMatch(/continue-on-error/);
    });

    it('swallows a failed gate with || true, || : or set +e', () => {
      const gate = '        run: cargo test --release --locked --target "$TARGET" --lib\n';
      for (const [variant, expected] of [
        [' || true', /swallows a failure with \|\| true/],
        [' || :', /swallows a failure with \|\| true/],
        [' || exit 0', /swallows a failure with \|\| true/],
      ] as const) {
        expect(releaseWorkflowProblems(changed(gate, gate.replace('\n', `${variant}\n`))).join('\n'), variant).toMatch(expected);
      }
      const off = changed(gate, '        run: |\n          set +e\n          cargo test --release --locked --target "$TARGET" --lib\n');
      expect(releaseWorkflowProblems(off).join('\n')).toMatch(/turns off errexit/);
    });

    it('changes the script of the codesign step that is allowed to end in || true', () => {
      const run = '        run: codesign --display --verbose=2 "dist/logseq-mcp-server-${VERSION}-${TARGET}" 2>&1 || true\n';
      expect(releaseWorkflowProblems(source)).toEqual([]);
      const added = changed(run, '        run: |\n          codesign --display --verbose=2 "dist/logseq-mcp-server-${VERSION}-${TARGET}" 2>&1 || true\n          cargo test --release --lib || true\n');
      expect(releaseWorkflowProblems(added).join('\n')).toMatch(/swallows a failure with \|\| true/);
      const swapped = changed(run, '        run: cargo test --release --locked --lib || true\n');
      expect(releaseWorkflowProblems(swapped).join('\n')).toMatch(/swallows a failure with \|\| true/);
      const renamed = changed('      - name: Show the macOS signature\n', '      - name: Show something else\n');
      expect(releaseWorkflowProblems(renamed).join('\n')).toMatch(/swallows a failure with \|\| true/);
    });

    it('sets shell: on a step, which can drop the fail-fast flags', () => {
      const broken = changed('      - name: Write SHA256SUMS\n', '      - name: Write SHA256SUMS\n        shell: bash {0}\n');
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/sets shell:/);
    });

    it('creates a second release with the flags before the subcommand', () => {
      const extra = '          gh -R "$GITHUB_REPOSITORY" release create "v${VERSION}" dist/LICENSE\n';
      const broken = changed('          mkdir dist\n', `          mkdir dist\n${extra}`);
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/expected one gh release create, found 2/);
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/gh release create has no --draft/);
    });

    it('creates a release or a tag through the API', () => {
      const curl = changed('          mkdir dist\n', '          mkdir dist\n          curl -X POST https://api.github.com/repos/x/y/releases -d {}\n');
      expect(releaseWorkflowProblems(curl).join('\n')).toMatch(/curl or wget to the releases or refs API/);
      const api = changed('          mkdir dist\n', '          mkdir dist\n          gh api repos/x/y/git/refs -f ref=refs/tags/v1 -f sha=abc\n');
      expect(releaseWorkflowProblems(api).join('\n')).toMatch(/gh api write to releases or refs/);
      const post = changed('          mkdir dist\n', '          mkdir dist\n          gh api --method POST repos/x/y/releases\n');
      expect(releaseWorkflowProblems(post).join('\n')).toMatch(/gh api write to releases or refs/);
    });

    it('calls a reusable workflow that is not pinned by a SHA', () => {
      const broken = changed('    name: Licence notices\n', '    name: Licence notices\n    uses: some-org/some-repo/.github/workflows/build.yml@main\n');
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/job "notices" calls .*not pinned/);
    });

    it('creates a release that is not a draft', () => {
      const broken = changed('            --draft \\\n', '');
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/gh release create has no --draft/);
    });

    it('sets --draft to false', () => {
      const broken = changed('            --draft \\\n', '            --draft=false \\\n');
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/has no --draft|sets --draft to a value/);
    });

    it('publishes the draft afterwards', () => {
      const broken = changed('            dist/logseq-mcp-server-* dist/SHA256SUMS dist/LICENSE dist/THIRD-PARTY-NOTICES.txt\n', '            dist/logseq-mcp-server-* dist/SHA256SUMS dist/LICENSE dist/THIRD-PARTY-NOTICES.txt\n          gh release edit "v${VERSION}" --draft=false\n');
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/gh release edit/);
    });

    it('creates the release on a dry run too', () => {
      const broken = changed('      - name: Create the draft release\n        if: ${{ !inputs.dry_run }}\n', '      - name: Create the draft release\n');
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/does not run only when dry_run is off/);
    });

    it('makes dry_run default to false', () => {
      const broken = changed('        type: boolean\n        default: true\n', '        type: boolean\n        default: false\n');
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/dry_run is not a boolean input that defaults to true/);
    });

    it('pins an action by a tag instead of a commit SHA', () => {
      const broken = changed('actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2', 'actions/attest@v4');
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/action "actions\/attest@v4" is not pinned/);
    });

    it('gives a build job a write token', () => {
      const broken = changed('    name: Licence notices\n', '    name: Licence notices\n    permissions:\n      contents: write\n');
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/exactly one job with a write permission/);
    });

    it('lets the last job run past a failed leg', () => {
      const broken = changed('    needs: [preflight, build, notices]\n', '    needs: [preflight, notices]\n');
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/does not need "build"/);
    });

    it('puts an input into a script instead of env', () => {
      const broken = changed('          mkdir dist\n', '          mkdir dist\n          echo "${{ inputs.version }}"\n');
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/run script holds an expression/);
    });

    it('tags or pushes', () => {
      const broken = changed('          mkdir dist\n', '          mkdir dist\n          git tag "v${VERSION}"\n');
      expect(releaseWorkflowProblems(broken).join('\n')).toMatch(/git tag or git push/);
    });
  });
});

describe('ADR-0035: no other workflow creates a release or a tag', () => {
  it('flags the commands and actions that create or change a release or a tag', () => {
    const text = [
      'run: gh release create v1 --draft',
      '  gh release edit v1 --draft=false',
      '  gh release upload v1 a.txt',
      '  git tag v1',
      '  git push origin v1',
      '  gh api repos/x/y/releases -X POST',
      '  gh api repos/x/y/git/refs -f ref=refs/tags/v1',
      '- uses: softprops/action-gh-release@abc',
      '  contents: write',
      '  gh -R x/y release create v2',
      '  gh --repo x/y release edit v1',
      '  curl -X POST https://api.github.com/repos/x/y/releases',
      '  gh release list',
      '  gh api repos/x/y/releases --paginate --jq .',
      '# git tag v1 in a comment',
    ].join('\n');
    expect(releaseOrTagHits('x.yml', text, { allowReleaseCreate: false })).toHaveLength(12);
    expect(releaseOrTagHits('x.yml', text, { allowReleaseCreate: true })).toHaveLength(10);
  });

  it('joins a command continued over lines', () => {
    expect(releaseOrTagHits('x.yml', 'run: |\n  gh \\\n    release create v1', { allowReleaseCreate: false })).toHaveLength(1);
    expect(releaseOrTagHits('x.yml', 'run: |\n  gh release \\\n    create v1', { allowReleaseCreate: false })).toHaveLength(1);
  });

  it('holds for every workflow besides release.yml', () => {
    const others = readdirSync(WORKFLOWS_DIR).filter(name => /\.ya?ml$/.test(name) && name !== 'release.yml');
    expect(others.length).toBeGreaterThan(0);
    const hits = others.flatMap(name => releaseOrTagHits(name, readWorkflow(name), { allowReleaseCreate: false }));
    expect(hits, 'a release or a tag is made only by release.yml, as a draft, and published by the maintainer (ADR-0035)').toEqual([]);
  });
});
