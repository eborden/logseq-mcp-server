# Publish the release binaries to PyPI as platform wheels built from the GitHub Release

## Context

[ADR-0035 (native-binary-release-on-github-releases)](0035-native-binary-release-on-github-releases.md) ships the Rust server as native binaries on GitHub Releases, started by a shell launcher inside the Claude Code plugin. It gives up the one-line install that MCP clients outside Claude Code expect, and says an npm channel is the maintainer's later choice (Decision 8). The facts that matter for a second channel:

- **Clients start servers with `uvx` or `npx`.** A copy-paste config (`"command": "uvx", "args": ["logseq-mcp-server"]`) is how most MCP hosts that are not Claude Code are set up. Nothing in the first release serves them except a clone and a build, or a hand-downloaded binary.
- **The PyPI name is free.** On 2026-10-09 `https://pypi.org/pypi/logseq-mcp-server/json` answers 404. The npm name of the same spelling belongs to another maintainer (ADR-0035), so PyPI is the one registry where the project can hold its own unscoped name. Other LogSeq MCP servers exist on PyPI under other names, so the name is not a differentiator. PyPI has no scopes, so a name is first come, first served, and it is held only by publishing a real release: PyPI discourages empty placeholder projects.
- **PyPI can carry a native binary.** A wheel is a zip with a platform tag. Anything in its `scripts` data directory is installed as an executable on `PATH` by pip, uv and pipx, so `uvx logseq-mcp-server` runs the Rust binary itself, with no Python process beside it. Projects such as ruff ship this way.
- **The bytes must be the ones that were gated.** `release.yml` (ADR-0035) builds each target, runs the parity test and the unit tests against that build, writes `SHA256SUMS` and attests build provenance. A second build for PyPI would produce different bytes that no gate saw.
- **Nothing is published from a session.** ADR-0017's rule, carried by ADR-0035 Decision 10 and CLAUDE.md: publishing is a manual workflow, run by the maintainer, from `main`, with `dry_run` on by default and third-party actions pinned by commit SHA.
- **A release job should install nothing.** A build step that runs `npm ci` or `pip install` before it handles the bytes that ship adds a supply chain to the one place that must have none (Foundations 4.11).

## Decision

We publish the three binaries of ADR-0035 to PyPI as platform wheels, **built from the published GitHub Release and never rebuilt**, by one new manual workflow. A session builds, uploads or publishes nothing.

1. **One project, wheels only.** The PyPI project is `logseq-mcp-server`, owned by the maintainer. There is no source distribution: a source build would need a Rust toolchain and would not be the gated binary. A platform with no wheel (Windows, Linux on arm64) fails to install with pip's "no matching distribution", which is the same support as ADR-0035's first release, stated in the package description.
2. **What a wheel holds.** The release binary, unmodified, at `logseq_mcp_server-<version>.data/scripts/logseq-mcp-server` with mode 0755, plus `METADATA`, `WHEEL`, `RECORD` and the two licence files (`LICENSE`, `THIRD-PARTY-NOTICES.txt`) in `.dist-info/licenses`. The Python tag is `py3-none`, since there is no Python code. The metadata is 2.4, with `License-Expression: MIT` and the long description from `pypi/README.md`. The platform tags:

   | Release target | Wheel platform tag |
   |---|---|
   | `aarch64-apple-darwin` | `macosx_11_0_arm64` |
   | `x86_64-apple-darwin` | `macosx_10_12_x86_64` |
   | `x86_64-unknown-linux-musl` | `manylinux_2_17_x86_64.musllinux_1_2_x86_64` |

   The musl binary is static (ADR-0035 Decision 1), so it runs on glibc and musl alike and takes both Linux tags. The two macOS tags are Rust's default minimum versions. They are a claim about the binary, and the first dry run checks it (Decision 9).
3. **Built from the release, after it is public.** The workflow downloads `v<version>`'s assets, verifies each binary with `gh attestation verify` against `release.yml` of this repository, and builds the wheels from those files. The release has to be public (not a draft), so a wheel is built only after ADR-0035's pre-publish and post-publish checks. A run fails if the release is a draft or a pre-release.
4. **The builder is one standard-library Python script**, `scripts/pypi/build_wheels.py`, not a packaging tool. It needs nothing installed (the runner has `python3`), so no package is fetched in the job that handles the binaries. It refuses, and writes nothing, unless: the version is plain `x.y.z`; `SHA256SUMS` is well formed and lists every input with a matching hash; each binary's header is for the CPU and operating system its wheel tag claims (Mach-O arm64, Mach-O x86_64, ELF x86_64), so a mislabeled asset cannot ship; and the output directory holds no wheels already. The same inputs always give the same bytes (a fixed timestamp, a fixed file order). Its tests are `scripts/pypi/test_build_wheels.py`, run by the workflow and by the guard job.
5. **The workflow is `.github/workflows/pypi.yml`**, under ADR-0035 Decision 10's rules:
   - It runs only on `workflow_dispatch`, only from `main`, and `dry_run` defaults to true. Its inputs are `version`, which must equal `rust/Cargo.toml`, `package.json` and both plugin manifests (so there is no fifth place that holds a version), and `dry_run`.
   - **Preflight** fails the run before it builds if the version is wrong, if the GitHub release is a draft or missing, or if PyPI already has the version (a file name can never be uploaded twice).
   - **Build** runs the builder's tests, downloads the assets, verifies the attestations, builds the three wheels, installs the Linux wheel into a clean virtual environment and checks the executable is the release binary byte for byte, checks the wheel set is exactly three files, and uploads them as workflow artifacts. A dry run stops here.
   - **Publish** runs only on a real run and only after the other jobs. It is the only job with a token, `id-token: write`, and the only one that can upload. It waits for the `pypi` environment, which the maintainer configures with themselves as a required reviewer, so an upload is a second deliberate click, as publishing the draft is for GitHub Releases.
6. **Trusted publishing, no stored credential.** PyPI is told to accept uploads from this repository's `pypi.yml` in the `pypi` environment, and exchanges the run's OIDC identity for a short-lived token. No API token is created, stored or referenced anywhere. The upload step is `pypa/gh-action-pypi-publish` pinned by commit SHA: PyPA's own action, the one the trusted-publishing guide names, and v1.14.2 (published 2026-07-29) is the version pinned. It also publishes PEP 740 attestations for the files, by its default. This is the only new third-party action, and it is vetted here as CLAUDE.md requires.
7. **One version, one release.** The PyPI version is the release version. A wheel is never edited or re-uploaded. A bad upload is fixed by a new patch version cut the same way, and yanking the bad one on PyPI is the maintainer's call.
8. **The plugin does not change.** The Claude Code plugin keeps ADR-0035's launcher. PyPI is a channel for other MCP hosts, not a second way the plugin starts the server.
9. **The first publish is manual, by the maintainer, in this order, none of it from a session:**
   1. ADR-0035's release exists and is public, and its post-publish check passed.
   2. On PyPI, register a pending trusted publisher for the project `logseq-mcp-server`: owner `eborden`, repository `logseq-mcp-server`, workflow `pypi.yml`, environment `pypi`. In the repository's settings, create the `pypi` environment with the maintainer as a required reviewer and deployment limited to `main`.
   3. Run `pypi.yml` with `dry_run` on. Download the `wheels` artifact and read the log. Check the minimum macOS version of each Mach-O binary (`otool -l <binary>`, the `minos` of `LC_BUILD_VERSION`) against the macOS tag in Decision 2. If a binary needs a newer macOS, the tag is raised in `build_wheels.py` (a PR) before any upload.
   4. Run it with `dry_run` off, and approve the `pypi` environment. That uploads the files and creates the project.
   5. **Post-publish check.** On a clean macOS machine and a clean Linux machine, with no override, run `uvx logseq-mcp-server` through an MCP client and call one tool. This is also where it is confirmed that an installer's copy of the binary runs without a Gatekeeper warning. If it fails, the release is not edited: the fix is a new patch version, and the maintainer decides whether to yank the old one.
   6. A follow-up PR adds the `uvx` install to the README, the changelog and `pypi/README.md`'s links. They say nothing about PyPI until the check above passes.

### Alternatives rejected

- **A pure-Python launcher wheel that downloads the binary on first run.** It keeps the wheel small and avoids per-platform wheels, but it needs the network at first start, leaves a Python process resident for the whole session (the cost ADR-0035 Decision 6 avoided by choosing a shell `exec`), repeats the launcher's download and checksum logic in a second language, and the wheel is not the gated bytes.
- **maturin or another packaging tool.** It would compile the crate again inside the PyPI job, producing bytes no gate saw, and it adds a build dependency. The binary is already built and attested, so only a zip with the right metadata is missing.
- **Building the wheels inside `release.yml`.** It would couple the GitHub release to PyPI's rules, such as a name that can be uploaded once, before the maintainer has checked the release. Keeping them apart lets PyPI follow a release that has already passed its checks.
- **npm first.** It reaches the same hosts, but its unscoped name is taken, it needs a scope, and an `npx` client needs Node, which this project's launcher avoids. It stays the maintainer's later choice (ADR-0035 Decision 8) and is not affected by this decision.
- **A container image.** The server must reach LogSeq's API on the host's localhost, which a container hides by default, and a client config that starts a container is heavier than one that runs a binary.

## Consequences

- **More reach for one registry's worth of work.** A client config of `uvx logseq-mcp-server` works on macOS and Linux x86_64 with no Rust toolchain, no clone and no Node.
- **One more manual workflow, one more place that can go wrong.** `pypi.yml` has never run, as `release.yml` had not when ADR-0035 was accepted. Its first dry run on GitHub is the real test, and the attestation check, the install check and the `minos` check (Decision 9.3) cannot be tried before a release exists.
- **PyPI is immutable.** A file name is uploaded once. A mistake costs a version number, and the name stays taken either way.
- **The name is claimed by the first real upload.** Until then anyone could publish `logseq-mcp-server` on PyPI. The risk is accepted: a placeholder would break PyPI's guidance, and the first release is close.
- **Platform support is exactly ADR-0035's.** No Windows and no Linux arm64 wheel. Adding a target is additive: a row in the table above, the target in `release.yml`, and a matching branch in the builder's header check.
- **Licence notices ship in each wheel**, as they do on the release.
- **The checksum and the attestation cover the binaries only.** `LICENSE` and `THIRD-PARTY-NOTICES.txt` are listed in `SHA256SUMS` but not attested, as ADR-0035 Decision 4 already states.
- **Python is a tooling dependency of the repository now, but only `python3` itself.** The workflow uses the runner's `python3` with the standard library and installs no package. The guard job also needs `python3` on its runner, because a guard test runs the builder's tests (GitHub's Ubuntu runners have it, and so does a macOS developer machine).
- **Nothing in ADR-0035 is superseded.** Its decisions stand, and this one adds a channel after the release it describes.

## Status

proposed

Date: 2026-10-09

## Mechanical enforcement

- test: `tests/guards/pypi-workflow-guards.test.ts` (pypi.yml triggers only on workflow_dispatch, gates every job to main and the publish job also to a real run, defaults dry_run to true, gives only the last job a token and only id-token: write, runs it in the pypi environment, uploads only through the pinned PyPA action and no command, references no secret or API token, pins every action by SHA with a version comment, and builds from the release assets with the builder, tests and attestation check, with negative tests that it fails when any of that is broken)
- test: `tests/guards/pypi-wheels.test.ts` (the builder's own tests pass in the guard job, and the builder imports only the standard library, so the release job installs nothing)
- test: `scripts/pypi/test_build_wheels.py` (one wheel per target with the binary byte for byte and executable, a correct RECORD, the right tags and metadata, identical bytes on a second build, and a refusal for a wrong checksum, an unlisted or missing file, a binary for another CPU or OS, a bad version and a stale output directory)
- test: `tests/guards/release-workflow-guards.test.ts` (no workflow other than release.yml creates or edits a release or a tag, which covers pypi.yml)
- ci: `.github/workflows/ci.yml` (the guard job runs the two guards above, and actionlint and ShellCheck lint every workflow, including pypi.yml)
- reviewer: the maintainer's dry run of pypi.yml proves the attestation check, the install check and the macOS minimum-version check before the first upload (Decision 9.3), and a reviewer checks it was done; and that no PR adds a step that uploads to PyPI, tags or releases outside the manual workflows
