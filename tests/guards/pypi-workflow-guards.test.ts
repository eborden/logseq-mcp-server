import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { at, jobCondition, listOf, parseWorkflowYaml, triggers, type YamlNode } from './workflow-yaml.js';

// Guards for ADR-0036 (pypi-wheels-from-the-release-binaries), which carries ADR-0017's and ADR-0035's rule over to the
// PyPI workflow: an upload is started by the maintainer by hand, from main, and a run defaults to a dry run. The one
// job that can upload is the last, holds the only token (id-token: write, for trusted publishing), and waits for the
// `pypi` environment, so an upload is a second, deliberate click. The workflow builds nothing: it uploads the wheels
// that release.yml built, checksummed, attested and attached to the release (release-wheels-guards holds that side).
//
// The checks are functions of the workflow's text, so the negative tests below can hand them a broken copy and see
// them fail: a guard that has never been seen to fail proves nothing.

const WORKFLOWS_DIR = new URL('../../.github/workflows/', import.meta.url);
const source = readFileSync(new URL('pypi.yml', WORKFLOWS_DIR), 'utf-8');

const MAIN_GATE = /^github\.ref == 'refs\/heads\/main'$/;
const PUBLISH_GATE = /^github\.ref == 'refs\/heads\/main' && !inputs\.dry_run$/;
const PUBLISH_JOB = 'publish';
const VERIFY_JOB = 'verify';
const PUBLISH_ACTION = 'pypa/gh-action-pypi-publish';
const STATUS_FUNCTION = /\b(?:always|cancelled|failure|success)\s*\(/;
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;
// Commands that put a package on a registry, whatever the tool. The one upload is the pinned action in the publish job.
const UPLOAD_COMMAND = /\b(?:twine\s+upload|uv\s+publish|npm\s+publish|pnpm\s+publish|yarn\s+publish|cargo\s+publish|flit\s+publish|poetry\s+publish|hatch\s+publish|pdm\s+publish|maturin\s+publish)\b/;
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

const jobsOf = (workflow: YamlNode) => [...at(workflow, 'jobs').map.entries()];
const stepsOf = (job: YamlNode) => job.map.get('steps')?.items ?? [];
const stepName = (step: YamlNode) => step.map.get('name')?.value ?? step.map.get('uses')?.value ?? String(step.line);
const needsOf = (job: YamlNode): string[] => {
  const needs = job.map.get('needs');
  if (!needs) return [];
  return needs.items.length > 0 || needs.value.startsWith('[') ? listOf(needs) : [needs.value];
};

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
  const verify = jobs.find(([name]) => name === VERIFY_JOB)?.[1];
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

  // The one upload: the pinned PyPA action, once, last, in the publish job, with no input but the directory
  const uploads = jobs.flatMap(([name, job]) => stepsOf(job).filter(step => step.map.get('uses')?.value.startsWith(`${PUBLISH_ACTION}@`)).map(() => name));
  if (JSON.stringify(uploads) !== JSON.stringify([PUBLISH_JOB])) problems.push(`expected ${PUBLISH_ACTION} once, in the publish job, found it in ${JSON.stringify(uploads)}`);
  if (publish) {
    const publishSteps = stepsOf(publish);
    const upload = publishSteps[publishSteps.length - 1];
    if (!upload?.map.get('uses')?.value.startsWith(`${PUBLISH_ACTION}@`)) problems.push('the upload is not the last step of the publish job');
    else if (JSON.stringify([...(upload.map.get('with')?.map.keys() ?? [])]) !== '["packages-dir"]') problems.push('the upload step sets an input besides packages-dir (skip-existing, attestations and the like change what is uploaded and checked)');
  }
  for (const [i, line] of commandText(text).split('\n').entries()) {
    if (UPLOAD_COMMAND.test(line)) problems.push(`a command uploads a package (${line.trim()}) [${i + 1}]`);
  }

  // It builds nothing and reads no version file: the wheels are the release's, and the version files move on with main
  if (/build_wheels|\bcargo\b|\brustc\b|\bmaturin\b|Cargo\.toml|package\.json|plugin\.json|marketplace\.json/.test(commandText(text))) problems.push('the workflow builds something or reads a version file; it only uploads the wheels of the release');
  if (steps.some(step => step.map.get('uses')?.value.startsWith('actions/checkout@'))) problems.push('the workflow checks out the repository, which it has no use for: the release holds what it uploads');

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
      const label = `step "${stepName(step)}" of job "${name}"`;
      if (STATUS_FUNCTION.test(step.map.get('if')?.value ?? '')) problems.push(`${label} has a status function in its if:`);
      if (step.map.has('shell')) problems.push(`${label} sets shell:, which can drop the fail-fast flags`);
      const run = commandText(step.map.get('run')?.value ?? '');
      if (/\bset\s+\+(?:e|o\s+errexit)\b/.test(run)) problems.push(`${label} turns off errexit`);
      if (/\|\|\s*(?:true|:|exit\s+0)(?:\s|;|$)/.test(run)) problems.push(`${label} swallows a failure with || true`);
    }
  }

  // The verify job takes the wheels from the release and checks every one before anything is uploaded
  if (!verify) problems.push(`no "${VERIFY_JOB}" job`);
  else {
    const verifySteps = stepsOf(verify);
    const runOf = (step: YamlNode) => commandText(step.map.get('run')?.value ?? '');
    const all = verifySteps.map(runOf).join('\n');
    if (!/gh release download "\$TAG_NAME" --repo "\$GITHUB_REPOSITORY" --dir assets\s+--pattern '\*\.whl' --pattern SHA256SUMS --pattern "logseq-mcp-server-\$\{VERSION\}-x86_64-unknown-linux-musl"/.test(all)) problems.push('the verify job does not download exactly the wheels, SHA256SUMS and the Linux binary of the release');
    if (!/test "\$\(find assets -type f \| wc -l\)" -eq 5/.test(all)) problems.push('the verify job does not check that it downloaded exactly five files');
    for (const wheel of WHEEL_NAMES) if (!all.includes(wheel)) problems.push(`the verify job does not name ${wheel}`);
    if (!/sha256sum --check wheels\.sha256/.test(all) || !/\| sha256sum --check -/.test(all)) problems.push('the verify job does not check the wheels and the Linux binary against SHA256SUMS');
    if (!/-c -E '\^\[0-9a-f\]\{64\}  logseq_mcp_server-\.\*\\\.whl\$' SHA256SUMS\)" -eq 3/.test(all)) problems.push('the verify job does not check that SHA256SUMS lists exactly three wheels');

    const attestIndex = verifySteps.findIndex(step => /gh attestation verify/.test(runOf(step)));
    const uploadIndex = verifySteps.findIndex(step => step.map.get('uses')?.value.startsWith('actions/upload-artifact@'));
    if (attestIndex === -1) problems.push('the verify job does not verify attestations');
    else {
      const attest = runOf(verifySteps[attestIndex]);
      if (!/for wheel in assets\/\*\.whl; do/.test(attest)) problems.push('the attestation check does not loop over every downloaded wheel');
      if (!/gh api "repos\/\$\{GITHUB_REPOSITORY\}\/commits\/\$\{TAG_NAME\}" --jq \.sha/.test(attest)) problems.push("the attestation check does not take the release's commit from the tag");
      for (const flag of ['--repo "$GITHUB_REPOSITORY"', '--signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/release.yml"', '--source-ref refs/heads/main', '--source-digest "$commit"', '--deny-self-hosted-runners']) {
        if (!attest.includes(flag)) problems.push(`the attestation check lacks ${flag}`);
      }
      if (uploadIndex !== -1 && attestIndex > uploadIndex) problems.push('the attestation is checked after the wheels are uploaded as artifacts');
    }
    const installIndex = verifySteps.findIndex(step => /\bcmp "\$\{RUNNER_TEMP\}\/check\/bin\/logseq-mcp-server" "assets\/logseq-mcp-server-\$\{VERSION\}-x86_64-unknown-linux-musl"/.test(runOf(step)));
    if (installIndex === -1) problems.push('the verify job does not check that the installed executable is the release binary');
    else if (!/--no-index --no-deps/.test(runOf(verifySteps[installIndex]))) problems.push('the install check can reach an index');
    const artifacts = verifySteps.filter(step => step.map.get('uses')?.value.startsWith('actions/upload-artifact@')).map(step => step.map.get('with')?.map.get('name')?.value);
    if (JSON.stringify(artifacts) !== '["wheels","wheel-checksums"]') problems.push(`the verify job uploads artifacts ${JSON.stringify(artifacts)}, not wheels and wheel-checksums`);
  }

  // The publish job checks the files again before it uploads them
  if (publish) {
    const publishRuns = stepsOf(publish).map(step => commandText(step.map.get('run')?.value ?? '')).join('\n');
    if (!/sha256sum --check \.\.\/checksums\/wheels\.sha256/.test(publishRuns)) problems.push('the publish job does not check the wheels against their checksums before the upload');
    if (!/test "\$\(find \. -type f \| wc -l\)" -eq 3/.test(publishRuns)) problems.push('the publish job does not check that it holds exactly three wheels');
    const downloads = stepsOf(publish).filter(step => step.map.get('uses')?.value.startsWith('actions/download-artifact@')).map(step => step.map.get('with')?.map.get('name')?.value);
    if (JSON.stringify(downloads) !== '["wheels","wheel-checksums"]') problems.push(`the publish job downloads ${JSON.stringify(downloads)}, not wheels and wheel-checksums`);
  }

  // The release is public, and the version is plain x.y.z, before anything is downloaded
  const preflightRuns = commandText(stepsOf(at(workflow, 'jobs', 'preflight')).map(step => step.map.get('run')?.value ?? '').join('\n'));
  if (!/\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/.test(preflightRuns)) problems.push('the preflight does not require a plain x.y.z version');
  if (!/gh release view "\$TAG_NAME" --repo "\$GITHUB_REPOSITORY" --json isDraft,isPrerelease/.test(preflightRuns)) problems.push('the preflight does not check that the release is public');
  if (!/https:\/\/pypi\.org\/pypi\/logseq-mcp-server\/\$\{VERSION\}\/json/.test(preflightRuns)) problems.push('the preflight does not check that PyPI lacks the version');
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
    expect(jobsOf(workflow).map(([name]) => name)).toEqual(['preflight', 'verify', 'publish']);
    expect(needsOf(at(workflow, 'jobs', 'publish'))).toEqual(['preflight', 'verify']);
    expect(at(workflow, 'jobs', 'publish', 'permissions', 'id-token').value).toBe('write');
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
      const gate = "    name: Download and check the wheels\n    needs: preflight\n    if: github.ref == 'refs/heads/main'\n";
      expect(problems(changed(gate, gate.replace("    if: github.ref == 'refs/heads/main'\n", '')))).toMatch(/job "verify" is not gated/);
      expect(problems(changed(gate, gate.replace("'refs/heads/main'", "'refs/heads/main' || github.event_name == 'workflow_dispatch'")))).toMatch(/job "verify" is not gated/);
    });

    it('lets the publish job run on a dry run', () => {
      expect(problems(changed("    if: github.ref == 'refs/heads/main' && !inputs.dry_run\n", "    if: github.ref == 'refs/heads/main'\n"))).toMatch(/job "publish" is not gated to exactly refs\/heads\/main and a real run/);
    });

    it('adds a status function to the publish gate, so it could run past a failed check', () => {
      for (const tail of ['always()', '!cancelled()', 'failure()']) {
        expect(problems(changed("    if: github.ref == 'refs/heads/main' && !inputs.dry_run\n", `    if: github.ref == 'refs/heads/main' && !inputs.dry_run && ${tail}\n`)), tail).toMatch(/job "publish" is not gated/);
      }
    });

    it('gives the verify job a token', () => {
      expect(problems(changed('    name: Download and check the wheels\n', '    name: Download and check the wheels\n    permissions:\n      id-token: write\n'))).toMatch(/expected only the "publish" job to set permissions/);
    });

    it('gives the publish job more than id-token: write', () => {
      expect(problems(changed('      id-token: write\n    steps:', '      id-token: write\n      contents: write\n    steps:'))).toMatch(/more than id-token: write/);
    });

    it('lets the publish job run past a failed job, or makes a job wait for it', () => {
      expect(problems(changed('    needs: [preflight, verify]\n', '    needs: [preflight]\n'))).toMatch(/does not need "verify"/);
      expect(problems(changed('    name: Download and check the wheels\n    needs: preflight\n', '    name: Download and check the wheels\n    needs: [preflight, publish]\n'))).toMatch(/needs the publish job/);
    });

    it('drops the pypi environment', () => {
      expect(problems(changed('    environment:\n      name: pypi\n', '    environment:\n      name: other\n'))).toMatch(/pypi environment/);
    });

    it('uses a long-lived credential', () => {
      expect(problems(changed('          packages-dir: dist\n', '          packages-dir: dist\n          password: ${{ secrets.PYPI_API_TOKEN }}\n'))).toMatch(/secret or an API token/);
      expect(problems(changed('          packages-dir: dist\n', '          packages-dir: dist\n          password: abc\n'))).toMatch(/sets password/);
      expect(problems(changed('          packages-dir: dist\n', '          packages-dir: dist\n          repository-url: https://example.test/legacy/\n'))).toMatch(/sets password, user or repository-url/);
    });

    it('gives the upload action an input that changes what is uploaded', () => {
      for (const input of ['skip-existing: true', 'attestations: false', 'verify-metadata: false']) {
        expect(problems(changed('          packages-dir: dist\n', `          packages-dir: dist\n          ${input}\n`)), input).toMatch(/sets an input besides packages-dir/);
      }
    });

    it('adds a step after the upload', () => {
      expect(problems(`${source.trimEnd()}\n\n      - name: Afterwards\n        run: echo done\n`)).toMatch(/upload is not the last step/);
    });

    it('uploads with a command instead of the action', () => {
      for (const command of ['twine upload dist/*', 'uv publish dist/*', 'npm publish', 'cargo publish']) {
        expect(problems(changed('          mkdir assets\n', `          mkdir assets\n          ${command}\n`)), command).toMatch(/a command uploads a package/);
      }
    });

    it('uploads from a second step or another job', () => {
      const upload = '      - name: Second upload\n        uses: pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33 # v1.14.2\n';
      expect(problems(changed('      - name: Download the wheels from the release\n', `${upload}      - name: Download the wheels from the release\n`))).toMatch(/expected pypa\/gh-action-pypi-publish once, in the publish job/);
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
      expect(problems(changed('          test -x "${RUNNER_TEMP}/check/bin/logseq-mcp-server"\n', '          test -x "${RUNNER_TEMP}/check/bin/logseq-mcp-server" || true\n'))).toMatch(/swallows a failure/);
      expect(problems(changed('      - name: Install the Linux wheel into a clean environment\n', '      - name: Install the Linux wheel into a clean environment\n        continue-on-error: true\n'))).toMatch(/continue-on-error/);
      expect(problems(changed('      - name: Verify the attestation of each wheel\n', '      - name: Verify the attestation of each wheel\n        if: ${{ always() }}\n'))).toMatch(/status function in its if:/);
      expect(problems(changed('      - name: Verify the attestation of each wheel\n', '      - name: Verify the attestation of each wheel\n        shell: bash {0}\n'))).toMatch(/sets shell:/);
      expect(problems(changed('          mkdir assets\n', '          set +e\n          mkdir assets\n'))).toMatch(/turns off errexit/);
    });

    it('builds something, reads a version file or checks out the repository', () => {
      expect(problems(changed('          mkdir assets\n', '          mkdir assets\n          python3 -I scripts/pypi/build_wheels.py --version 1.0.0\n'))).toMatch(/builds something or reads a version file/);
      expect(problems(changed('          mkdir assets\n', '          mkdir assets\n          cargo build --release\n'))).toMatch(/builds something or reads a version file/);
      expect(problems(changed('          mkdir assets\n', '          mkdir assets\n          jq -r .version package.json\n'))).toMatch(/builds something or reads a version file/);
      expect(problems(changed('      - name: Download the wheels from the release\n', '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - name: Download the wheels from the release\n'))).toMatch(/checks out the repository/);
    });

    it('downloads more than the wheels, SHA256SUMS and the Linux binary, or does not count them', () => {
      expect(problems(changed("--pattern '*.whl' --pattern SHA256SUMS", "--pattern '*' --pattern SHA256SUMS"))).toMatch(/does not download exactly/);
      expect(problems(changed('          test "$(find assets -type f | wc -l)" -eq 5\n', ''))).toMatch(/exactly five files/);
    });

    it('stops checking the wheels against SHA256SUMS', () => {
      expect(problems(changed('          sha256sum --check wheels.sha256\n', ''))).toMatch(/does not check the wheels and the Linux binary against SHA256SUMS/);
      expect(problems(changed("          test \"$(grep -c -E '^[0-9a-f]{64}  logseq_mcp_server-.*\\.whl$' SHA256SUMS)\" -eq 3\n", ''))).toMatch(/SHA256SUMS lists exactly three wheels/);
    });

    it('stops verifying attestations, or loses one of the checks', () => {
      const attest = (flag: string) => changed(flag, '');
      expect(problems(changed('gh attestation verify', 'gh attestation download'))).toMatch(/does not verify attestations/);
      expect(problems(attest('              --source-ref refs/heads/main \\\n'))).toMatch(/lacks --source-ref refs\/heads\/main/);
      expect(problems(attest('              --source-digest "$commit" \\\n'))).toMatch(/lacks --source-digest "\$commit"/);
      expect(problems(attest('              --deny-self-hosted-runners'))).toMatch(/lacks --deny-self-hosted-runners/);
      expect(problems(changed('              --signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/release.yml" \\\n', '              --signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/other.yml" \\\n'))).toMatch(/lacks --signer-workflow/);
      expect(problems(changed('          for wheel in assets/*.whl; do\n', '          for wheel in assets/logseq_mcp_server-*arm64.whl; do\n'))).toMatch(/does not loop over every downloaded wheel/);
    });

    it('checks the attestation after the wheels are uploaded as artifacts', () => {
      const attest = /      # release\.yml attested each wheel[\s\S]*?(?=      # What an install does)/.exec(source)![0];
      const upload = /      # On a dry run these are the wheels to inspect[\s\S]*?(?=  # The only job with a token)/.exec(source)![0];
      const broken = source.replace(attest, '').replace(upload, `${upload}${attest}`);
      expect(broken).not.toBe(source);
      expect(problems(broken)).toMatch(/attestation is checked after the wheels are uploaded/);
    });

    it('stops checking that the installed executable is the release binary, or lets the install reach an index', () => {
      expect(problems(changed('          cmp "${RUNNER_TEMP}/check/bin/logseq-mcp-server" "assets/logseq-mcp-server-${VERSION}-x86_64-unknown-linux-musl"\n', ''))).toMatch(/installed executable is the release binary/);
      expect(problems(changed(' -m pip install --no-index --no-deps assets/', ' -m pip install assets/'))).toMatch(/can reach an index/);
    });

    it('does not pass the checksums to the publish job, or does not check them there', () => {
      expect(problems(changed('          sha256sum --check ../checksums/wheels.sha256\n', ''))).toMatch(/does not check the wheels against their checksums before the upload/);
      expect(problems(changed('          name: wheel-checksums\n          path: checksums\n', '          name: wheels\n          path: checksums\n'))).toMatch(/publish job downloads/);
    });

    it('stops requiring a plain version, a public release or a free PyPI version', () => {
      expect(problems(changed('          if ! [[ "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then\n', '          if false; then\n'))).toMatch(/plain x\.y\.z/);
      expect(problems(changed('--json isDraft,isPrerelease --jq', '--json url --jq'))).toMatch(/release is public/);
      expect(problems(changed('https://pypi.org/pypi/logseq-mcp-server/${VERSION}/json', 'https://pypi.org/'))).toMatch(/PyPI lacks the version/);
    });
  });
});
