import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { at, jobCondition, listOf, parseWorkflowYaml, triggers, type YamlNode } from './workflow-yaml.js';

// Guards for ADR-0036 (pypi-wheels-from-the-release-binaries), which carries ADR-0017's and ADR-0035's rule over to the
// PyPI workflow: an upload is started by the maintainer by hand, from main, and a run defaults to a dry run. The one
// job that can upload is the last, holds the only token (id-token: write, for trusted publishing), and waits for the
// `pypi` environment, so an upload is a second, deliberate click.
//
// The checks are functions of the workflow's text, so the negative tests below can hand them a broken copy and see
// them fail: a guard that has never been seen to fail proves nothing.

const WORKFLOWS_DIR = new URL('../../.github/workflows/', import.meta.url);
const source = readFileSync(new URL('pypi.yml', WORKFLOWS_DIR), 'utf-8');

const MAIN_GATE = /^github\.ref == 'refs\/heads\/main'$/;
const PUBLISH_GATE = /^github\.ref == 'refs\/heads\/main' && !inputs\.dry_run$/;
const PUBLISH_JOB = 'publish';
const PUBLISH_ACTION = 'pypa/gh-action-pypi-publish';
const STATUS_FUNCTION = /\b(?:always|cancelled|failure|success)\s*\(/;
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;
// Commands that put a package on a registry, whatever the tool. The one upload is the pinned action in the publish job.
const UPLOAD_COMMAND = /\b(?:twine\s+upload|uv\s+publish|npm\s+publish|pnpm\s+publish|yarn\s+publish|cargo\s+publish|flit\s+publish|poetry\s+publish|hatch\s+publish|pdm\s+publish|maturin\s+publish)\b/;

/** Workflow text without comment-only lines, with `\` line continuations joined: what a shell would read. */
function commandText(text: string): string {
  return text
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n')
    .replace(/\\\n\s*/g, ' ');
}

const jobsOf = (workflow: YamlNode) => [...at(workflow, 'jobs').map.entries()];
const stepsOf = (job: YamlNode) => job.map.get('steps')?.items ?? [];
const needsOf = (job: YamlNode): string[] => (job.map.has('needs') ? (job.map.get('needs')!.items.length > 0 || job.map.get('needs')!.value.startsWith('[') ? listOf(job.map.get('needs')!) : [job.map.get('needs')!.value]) : []);

/** Everything ADR-0036 says pypi.yml must hold. An empty list means it holds. */
function pypiWorkflowProblems(text: string): string[] {
  const problems: string[] = [];
  const workflow = parseWorkflowYaml(text);
  const jobs = jobsOf(workflow);

  // Manual only
  if (JSON.stringify(triggers(workflow)) !== '["workflow_dispatch"]') problems.push(`triggers are ${JSON.stringify(triggers(workflow))}, not only workflow_dispatch`);
  const inputs = at(workflow, 'on', 'workflow_dispatch', 'inputs');
  const dryRun = inputs.map.get('dry_run');
  if (!dryRun || dryRun.map.get('type')?.value !== 'boolean' || dryRun.map.get('default')?.value !== 'true') problems.push('dry_run is not a boolean input that defaults to true');
  if (inputs.map.get('version')?.map.get('required')?.value !== 'true') problems.push('version is not a required input');

  // Main only on every job; the publish job also only on a real run, in exactly this form
  if (jobs.length === 0) problems.push('no jobs');
  for (const [name, job] of jobs) {
    const isPublish = name === PUBLISH_JOB;
    if (!(isPublish ? PUBLISH_GATE : MAIN_GATE).test(jobCondition(job) ?? '')) {
      problems.push(`job "${name}" is not gated to exactly ${isPublish ? 'refs/heads/main and a real run (!inputs.dry_run)' : 'refs/heads/main'}`);
    }
  }

  // Least privilege: read at the top, and exactly one job, the last, with a token, and only id-token: write
  const top = workflow.map.get('permissions');
  if (!top || top.map.size !== 1 || top.map.get('contents')?.value !== 'read') problems.push('the workflow-level permissions are not only contents: read');
  const withPermissions = jobs.filter(([, job]) => job.map.has('permissions')).map(([name]) => name);
  if (JSON.stringify(withPermissions) !== JSON.stringify([PUBLISH_JOB])) problems.push(`expected only the "${PUBLISH_JOB}" job to set permissions, found ${JSON.stringify(withPermissions)}`);
  const publish = jobs.find(([name]) => name === PUBLISH_JOB)?.[1];
  if (!publish) problems.push(`no "${PUBLISH_JOB}" job`);
  else {
    const permissions = publish.map.get('permissions');
    if (!permissions || permissions.map.size !== 1 || permissions.map.get('id-token')?.value !== 'write') problems.push('the publish job holds more than id-token: write');
    for (const [name] of jobs) {
      if (name !== PUBLISH_JOB && !needsOf(publish).includes(name)) problems.push(`the publish job does not need "${name}", so it could run past a failed check`);
    }
    for (const [name, job] of jobs) {
      if (needsOf(job).includes(PUBLISH_JOB)) problems.push(`job "${name}" needs the publish job, which has to be last`);
    }
    // The environment is the maintainer's second click, and trusted publishing is registered against its name
    if (publish.map.get('environment')?.map.get('name')?.value !== 'pypi') problems.push('the publish job does not run in the pypi environment');
  }

  // No long-lived credential anywhere: trusted publishing only
  if (/\bsecrets\./.test(commandText(text)) || /\b(?:PYPI_API_TOKEN|PYPI_TOKEN|TWINE_PASSWORD|TWINE_USERNAME|UV_PUBLISH_TOKEN|UV_PUBLISH_PASSWORD)\b/.test(commandText(text))) problems.push('a secret or an API token is referenced; the upload is by trusted publishing only');
  if (/^\s*(?:password|user|repository-url|repository_url)\s*:/m.test(commandText(text))) problems.push('the upload step sets password, user or repository-url');

  // Every action pinned by commit SHA, with its version in a comment
  const steps = jobs.flatMap(([, job]) => stepsOf(job));
  for (const step of steps) {
    const uses = step.map.get('uses')?.value;
    if (uses !== undefined && !PINNED_ACTION.test(uses)) problems.push(`action "${uses}" is not pinned by a 40-character commit SHA`);
  }
  for (const line of commandText(text).split('\n')) {
    const uses = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
    if (uses && !/^\s+# v\d/.test(uses[2])) problems.push(`action "${uses[1]}" has no version comment`);
  }
  for (const [name, job] of jobs) {
    if (job.map.has('uses')) problems.push(`job "${name}" calls a reusable workflow ("${job.map.get('uses')!.value}"), which this workflow does not do`);
  }

  // The one upload: the pinned PyPA action, once, in the publish job
  const uploads = jobs.flatMap(([name, job]) => stepsOf(job).filter(step => step.map.get('uses')?.value.startsWith(`${PUBLISH_ACTION}@`)).map(() => name));
  if (JSON.stringify(uploads) !== JSON.stringify([PUBLISH_JOB])) problems.push(`expected ${PUBLISH_ACTION} once, in the publish job, found it in ${JSON.stringify(uploads)}`);
  for (const [i, line] of commandText(text).split('\n').entries()) {
    if (UPLOAD_COMMAND.test(line)) problems.push(`a command uploads a package (${line.trim()}) [${i + 1}]`);
  }

  // Inputs reach a shell only through env:, never inside the script text
  for (const step of steps) {
    const run = step.map.get('run')?.value;
    if (run !== undefined && run.includes('${{')) problems.push(`a run script holds an expression: ${run.split('\n').find(l => l.includes('${{'))!.trim()}`);
  }

  // A red check must stop the run: nothing may turn a failure into a pass or run a step past one
  for (const line of commandText(text).split('\n')) {
    if (/\bcontinue-on-error\b/.test(line)) problems.push(`continue-on-error: ${line.trim()}`);
  }
  for (const [name, job] of jobs) {
    for (const step of stepsOf(job)) {
      const label = `step "${step.map.get('name')?.value ?? step.map.get('uses')?.value ?? step.line}" of job "${name}"`;
      if (STATUS_FUNCTION.test(step.map.get('if')?.value ?? '')) problems.push(`${label} has a status function in its if:`);
      if (step.map.has('shell')) problems.push(`${label} sets shell:, which can drop the fail-fast flags`);
      const run = commandText(step.map.get('run')?.value ?? '');
      if (/\bset\s+\+(?:e|o\s+errexit)\b/.test(run)) problems.push(`${label} turns off errexit`);
      if (/\|\|\s*(?:true|:|exit\s+0)(?:\s|;|$)/.test(run)) problems.push(`${label} swallows a failure with || true`);
    }
  }

  // The build job does what ADR-0036 says: the builder's tests, the attestation check, the builder, the install check
  const buildRuns = commandText(stepsOf(at(workflow, 'jobs', 'build')).map(step => step.map.get('run')?.value ?? '').join('\n'));
  if (!/python3 -I -m unittest discover -s scripts\/pypi/.test(buildRuns)) problems.push("the build job does not run the wheel builder's tests");
  if (!/gh attestation verify[^\n]*--repo "\$GITHUB_REPOSITORY"[^\n]*--signer-workflow "\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/release\.yml"/.test(buildRuns)) problems.push('the build job does not verify each binary against release.yml with gh attestation verify');
  if (!/python3 -I scripts\/pypi\/build_wheels\.py --version "\$VERSION" --assets assets --readme pypi\/README\.md --out dist/.test(buildRuns)) problems.push('the build job does not run build_wheels.py on the release assets');
  if (!/\bgh release download\b/.test(buildRuns)) problems.push('the build job does not download the release assets');
  if (/\bcargo\b|\brustc\b/.test(buildRuns)) problems.push('the build job builds Rust: the wheels carry the release binaries and rebuild nothing');
  return problems;
}

describe('ADR-0036: pypi.yml is manual, main-only, dry-run by default and uploads only from its last job', () => {
  it('holds every rule', () => {
    expect(pypiWorkflowProblems(source)).toEqual([]);
  });

  it('triggers on workflow_dispatch and nothing else', () => {
    expect(triggers(parseWorkflowYaml(source))).toEqual(['workflow_dispatch']);
  });

  it('has a boolean dry_run input that defaults to true', () => {
    const dryRun = at(parseWorkflowYaml(source), 'on', 'workflow_dispatch', 'inputs', 'dry_run');
    expect(at(dryRun, 'type').value).toBe('boolean');
    expect(at(dryRun, 'default').value).toBe('true');
  });

  it('has the three jobs, with publish last and the only one holding a token', () => {
    const workflow = parseWorkflowYaml(source);
    expect(jobsOf(workflow).map(([name]) => name)).toEqual(['preflight', 'build', 'publish']);
    expect(needsOf(at(workflow, 'jobs', 'publish'))).toEqual(['preflight', 'build']);
    expect(at(workflow, 'jobs', 'publish', 'permissions', 'id-token').value).toBe('write');
  });

  it('builds the three wheels the builder makes, and uploads exactly those', () => {
    const publishRuns = stepsOf(at(parseWorkflowYaml(source), 'jobs', 'publish')).map(step => step.map.get('run')?.value ?? '').join('\n');
    for (const tag of ['macosx_11_0_arm64', 'macosx_10_12_x86_64', 'manylinux_2_17_x86_64.musllinux_1_2_x86_64']) {
      expect(publishRuns, tag).toContain(`py3-none-${tag}.whl`);
    }
  });

  describe('fails when it is broken', () => {
    /** The source with `needle` replaced, and a check that it was there, so a rewritten workflow can't make a case vacuous. */
    const changed = (needle: string, replacement: string) => {
      expect(source.split(needle).length, `pypi.yml no longer holds ${JSON.stringify(needle)}`).toBe(2);
      return source.replace(needle, replacement);
    };
    const problems = (broken: string) => pypiWorkflowProblems(broken).join('\n');

    it('gains a push, pull_request or schedule trigger', () => {
      for (const event of ['push:\n    tags: [v*]', 'pull_request:\n    branches: [main]', 'schedule:\n    - cron: "0 0 * * *"']) {
        expect(problems(changed('on:\n  workflow_dispatch:', `on:\n  ${event}\n  workflow_dispatch:`)), event).toMatch(/not only workflow_dispatch/);
      }
    });

    it('makes dry_run default to false', () => {
      expect(problems(changed('        type: boolean\n        default: true\n', '        type: boolean\n        default: false\n'))).toMatch(/dry_run is not a boolean input that defaults to true/);
    });

    it('loses the main gate on a job, or opens it with an ||', () => {
      const gate = "    name: Build and check the wheels\n    needs: preflight\n    if: github.ref == 'refs/heads/main'\n";
      expect(problems(changed(gate, gate.replace("    if: github.ref == 'refs/heads/main'\n", '')))).toMatch(/job "build" is not gated/);
      expect(problems(changed(gate, gate.replace("'refs/heads/main'", "'refs/heads/main' || github.event_name == 'workflow_dispatch'")))).toMatch(/job "build" is not gated/);
    });

    it('lets the publish job run on a dry run', () => {
      expect(problems(changed("    if: github.ref == 'refs/heads/main' && !inputs.dry_run\n", "    if: github.ref == 'refs/heads/main'\n"))).toMatch(/job "publish" is not gated to exactly refs\/heads\/main and a real run/);
    });

    it('adds a status function to the publish gate, so it could run past a failed build', () => {
      for (const tail of ['always()', '!cancelled()', 'failure()']) {
        expect(problems(changed("    if: github.ref == 'refs/heads/main' && !inputs.dry_run\n", `    if: github.ref == 'refs/heads/main' && !inputs.dry_run && ${tail}\n`)), tail).toMatch(/job "publish" is not gated/);
      }
    });

    it('gives a build job a token', () => {
      expect(problems(changed('    name: Build and check the wheels\n', '    name: Build and check the wheels\n    permissions:\n      id-token: write\n'))).toMatch(/expected only the "publish" job to set permissions/);
    });

    it('gives the publish job more than id-token: write', () => {
      expect(problems(changed('      id-token: write\n    steps:', '      id-token: write\n      contents: write\n    steps:'))).toMatch(/more than id-token: write/);
    });

    it('lets the publish job run past a failed job, or makes a job wait for it', () => {
      expect(problems(changed('    needs: [preflight, build]\n', '    needs: [preflight]\n'))).toMatch(/does not need "build"/);
      expect(problems(changed('    name: Build and check the wheels\n    needs: preflight\n', '    name: Build and check the wheels\n    needs: [preflight, publish]\n'))).toMatch(/needs the publish job/);
    });

    it('drops the pypi environment', () => {
      expect(problems(changed('    environment:\n      name: pypi\n', '    environment:\n      name: other\n'))).toMatch(/pypi environment/);
    });

    it('uses a long-lived credential', () => {
      expect(problems(changed('          packages-dir: dist\n', '          packages-dir: dist\n          password: ${{ secrets.PYPI_API_TOKEN }}\n'))).toMatch(/secret or an API token/);
      expect(problems(changed('          packages-dir: dist\n', '          packages-dir: dist\n          password: abc\n'))).toMatch(/sets password/);
      expect(problems(changed('          packages-dir: dist\n', '          packages-dir: dist\n          repository-url: https://example.test/legacy/\n'))).toMatch(/sets password, user or repository-url/);
    });

    it('uploads with a command instead of the action', () => {
      for (const command of ['twine upload dist/*', 'uv publish dist/*', 'npm publish', 'cargo publish']) {
        expect(problems(changed('          mkdir assets\n', `          mkdir assets\n          ${command}\n`)), command).toMatch(/a command uploads a package/);
      }
    });

    it('uploads from a second step or another job', () => {
      const upload = '      - name: Second upload\n        uses: pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33 # v1.14.2\n';
      expect(problems(changed('      - name: Test the wheel builder\n', `${upload}      - name: Test the wheel builder\n`))).toMatch(/expected pypa\/gh-action-pypi-publish once, in the publish job/);
      expect(problems(changed('      - name: Upload to PyPI\n', `${upload}      - name: Upload to PyPI\n`))).toMatch(/expected pypa\/gh-action-pypi-publish once, in the publish job/);
    });

    it('pins an action by a tag instead of a commit SHA', () => {
      expect(problems(changed('pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33 # v1.14.2', 'pypa/gh-action-pypi-publish@release/v1'))).toMatch(/not pinned by a 40-character commit SHA/);
    });

    it('drops the version comment of a pinned action', () => {
      expect(problems(changed('pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33 # v1.14.2', 'pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33'))).toMatch(/has no version comment/);
    });

    it('calls a reusable workflow', () => {
      expect(problems(changed('    name: Check the version, the release and PyPI\n', '    name: Check the version, the release and PyPI\n    uses: some-org/some-repo/.github/workflows/build.yml@main\n'))).toMatch(/calls a reusable workflow/);
    });

    it('puts an input into a script instead of env', () => {
      expect(problems(changed('          mkdir assets\n', '          mkdir assets\n          echo "${{ inputs.version }}"\n'))).toMatch(/run script holds an expression/);
    });

    it('swallows a failure, sets continue-on-error or a status function, or turns errexit off', () => {
      expect(problems(changed('        run: python3 -I -m unittest discover -s scripts/pypi\n', '        run: python3 -I -m unittest discover -s scripts/pypi || true\n'))).toMatch(/swallows a failure/);
      expect(problems(changed('      - name: Test the wheel builder\n', '      - name: Test the wheel builder\n        continue-on-error: true\n'))).toMatch(/continue-on-error/);
      expect(problems(changed('      - name: Build the wheels\n', '      - name: Build the wheels\n        if: ${{ always() }}\n'))).toMatch(/status function in its if:/);
      expect(problems(changed('      - name: Build the wheels\n', '      - name: Build the wheels\n        shell: bash {0}\n'))).toMatch(/sets shell:/);
      expect(problems(changed('          mkdir assets\n', '          set +e\n          mkdir assets\n'))).toMatch(/turns off errexit/);
    });

    it('stops testing the builder, verifying attestations or building from the release assets', () => {
      expect(problems(changed('        run: python3 -I -m unittest discover -s scripts/pypi\n', '        run: echo skipped\n'))).toMatch(/does not run the wheel builder's tests/);
      expect(problems(changed('              --signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/release.yml"\n', '              --signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/other.yml"\n'))).toMatch(/does not verify each binary against release.yml/);
      expect(problems(changed('--assets assets --readme', '--assets elsewhere --readme'))).toMatch(/does not run build_wheels.py on the release assets/);
    });

    it('rebuilds the binaries instead of using the release', () => {
      expect(problems(changed('          mkdir assets\n', '          mkdir assets\n          cargo build --release\n'))).toMatch(/builds Rust/);
    });
  });
});
