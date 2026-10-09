# Release the Rust server as native binaries on GitHub Releases, started by one thin launcher

## Context

The Rust server is the only server (#349, #356). Nothing ships it yet. The pieces that were built for the TypeScript server are left over and don't run:

- `.claude-plugin/plugin.json` starts `node ${CLAUDE_PLUGIN_ROOT}/dist/index.js`, and there is no `dist/`.
- `package.json` has `bin` and `main` pointing at `dist/index.js`, a `build` script that exits 1, and `files` that list `dist`.
- `.github/workflows/publish.yml` builds the TypeScript server and runs `npm publish`.

[ADR-0017 (manual-npm-publish)](0017-manual-npm-publish.md) and [ADR-0018 (ship-as-claude-code-plugin)](0018-ship-as-claude-code-plugin.md) both say in their enforcement sections that how the Rust binary is shipped is open (#350, #355). This ADR closes that. #355 implements it and doesn't start until this is accepted. The cutover to `main` is #354.

What the decision has to fit:

- **Nothing may be published, tagged or released from a session.** ADR-0017 makes publishing a manual workflow the maintainer starts. CLAUDE.md states the working rule ("never publish, tag or release from a session") and it stands for whatever replaces the npm workflow. A release is also a public artifact that can't be taken back.
- **The plugin is installed from a git checkout.** The repository is its own marketplace with `"source": "./"` (ADR-0018), so a marketplace install copies the repository into a cache. Anything the server needs that isn't in git has to arrive some other way, and nothing can assume an npm publish has happened. Nothing has been published to npm (`CHANGELOG.md`), so the package name carries no installed base.
- **The binary is small and has no runtime dependencies.** It is one file of about 3 to 4 MB (#304), with no TLS and no OpenSSL (`reqwest` is built without TLS; LogSeq's API is plain HTTP on localhost). The footprint is the reason for the port: about 9 ms to the first `initialize` response against about 290 ms for Node, and about 2 MB resident against about 64 MB (#304, one tool ported; the full-port numbers are #353's).
- **Four targets were built in CI in #304**, with a cold release build of about 1 to 4 minutes and about 30 to 80 seconds with a warm dependency cache: aarch64 macOS (`macos-latest`), x86_64 macOS (`macos-15-intel`, the slowest at about 4 minutes cold), x86_64 Linux and x86_64 Windows. Only the compile was proved on Windows. The crate's tests run on Linux in CI.
- **Windows differs.** Where there is no `localtime_r`, "today" is the UTC day, while the retired TypeScript server read the local day on every platform (`rust/src/dates.rs`, listed in #299). The date presets of `query_by_date_range` and the prompts that name a week or a month can be a day off near midnight. The golden results leave the clock cases out of the release build's run, and no CI job runs the crate's tests on Windows.
- **macOS needs a signing story.** Developer ID signing and notarization need the maintainer's Apple account, which a session can't hold. An arm64 binary has to carry at least an ad-hoc signature to run, and the Rust linker adds one.

Options for getting the binary to the user, weighed on the issue (#350):

1. **Per-platform binaries attached to a GitHub Release, with one thin launcher that picks, downloads and verifies the right one.** The plugin and the npm package both start the launcher.
2. **An npm launcher package with one optional dependency per platform** (the esbuild pattern). npm picks the platform package at install time.
3. **A binary-only plugin**, with the binaries committed to git or to a release branch and a platform picker in front of them.
4. **`cargo install` only.**

## Decision

We recommend and choose option 1: **native binaries on GitHub Releases, started by one dependency-free Node launcher that the plugin and the npm package share.** The first release is a manual step by the maintainer, and no session builds, tags, publishes or releases anything.

1. **Targets.** The first release carries three binaries:
   - `aarch64-apple-darwin`, built on `macos-latest`.
   - `x86_64-apple-darwin`, built on `macos-15-intel`.
   - `x86_64-unknown-linux-musl`, built on `ubuntu-latest`. The binary is static, so it doesn't depend on the glibc of the runner or of the user's distribution. That matters because a binary built on a current Ubuntu needs a glibc most older distributions lack. Every dependency is pure Rust, so the musl build needs no C library beyond `libc`.

   `x86_64-pc-windows-msvc` is **not in the first release**. It joins when its date behavior is settled (a local-time implementation, or the maintainer accepting UTC in a recorded decision) and the release gate below runs green on a Windows runner. Adding a target later is additive. `aarch64-unknown-linux-musl` is also later: it wasn't measured in #304, and nobody has asked. The launcher says plainly when a platform has no binary, and names the manual route.
2. **Builds happen in one manual workflow.** A new `.github/workflows/release.yml`:
   - Runs only on `workflow_dispatch`, never on push, tag or pull request, and only from `main`, as ADR-0017 does for npm. Its inputs are `version` (it must equal the version in `rust/Cargo.toml`, `package.json` and both plugin manifests, or the run fails before it builds) and `dry_run`, which defaults to true.
   - Builds each target with `cargo build --release --locked --target <triple>` on the toolchain `rust/rust-toolchain.toml` pins, and holds each binary to the gate the release build already has in `ci.yml`: the parity test and its self-check, and the unit tests with `debug_assertions` off, run against that target's build. A target that fails the gate doesn't ship.
   - Joins the binaries into one set, writes `SHA256SUMS`, and attests build provenance for each binary with GitHub's attestation action (pinned by commit SHA, like every third-party action).
   - On a real run (`dry_run` false) creates a **draft** GitHub Release `v<version>` at the commit the run built, with the binaries and `SHA256SUMS` attached. A dry run only uploads the binaries as workflow artifacts. **A draft is not public and creates no tag. The maintainer publishes it from the Releases page, and that click creates the tag.** That is two deliberate steps, the run and the publish, with a chance to read the asset list and the checksums between them.
   - Gives the build jobs `contents: read` only. Only the last job gets `contents: write` and the attestation permissions.
3. **Naming.** An asset is the bare executable, named `logseq-mcp-server-<version>-<target triple>`, with `.exe` for Windows when it joins. It is not an archive, so the launcher needs no extraction code and a user can download the one file they need. `SHA256SUMS` lists each asset in `sha256sum` format. The release also carries the project's `LICENSE`. The licence notices of the dependencies (some are MPL-2.0 or Unicode-3.0, not MIT) need a generator, which is a new tool that CLAUDE.md says to vet first. The build task picks it, and a release doesn't go out without the notices.
4. **Integrity.** The launcher downloads the asset and `SHA256SUMS` from the release of its own version and refuses to run a file whose SHA-256 isn't the listed one. It never falls back to an unverified binary. `SHA256SUMS` catches a truncated or corrupted download, and the attestation (`gh attestation verify`) ties a binary to the workflow run and commit for anyone who wants that check. Neither protects against a compromised release account, since the checksum file sits beside the binary. Anything stronger, such as hashes recorded in the repository at the tagged commit, is a later decision.
5. **Signing.** The first release has no Developer ID signature and no notarization. macOS arm64 binaries carry the linker's ad-hoc signature. The launcher downloads with `fetch`, which doesn't set the quarantine attribute that makes Gatekeeper block an unsigned binary. A binary downloaded by hand through a browser is quarantined, and the README says to clear it with `xattr -d com.apple.quarantine <file>`. Whether this works on a clean machine is a step of the maintainer's first-release check (below), not an assumption. Developer ID signing and notarization are the maintainer's decision, need their Apple account, and are additive when they land.
6. **The launcher.** One file in the repository, with no dependencies, written for the Node floor of [ADR-0022 (minimum-node-22-12)](0022-minimum-node-22-12.md) so CI can test it (global `fetch` and `node:crypto` are enough). The file's path and name are #355's. It:
   - Reads its own package version and maps `process.platform` and `process.arch` to a target. `LOGSEQ_MCP_BINARY`, an absolute path, skips the download and runs that binary, for offline use and for tests.
   - Looks for `<user cache dir>/logseq-mcp-server/<version>/<asset>`. If it is missing, it downloads the asset and `SHA256SUMS` from `https://github.com/eborden/logseq-mcp-server/releases/download/v<version>/`, verifies the hash, sets the executable bit, and moves the file into place with an atomic rename, so a failed or concurrent download never leaves a half-written binary where the next start would run it.
   - Starts the binary with stdio inherited, forwards termination signals, and exits with the binary's exit code.
   - Writes every message of its own to stderr and nothing to stdout, which is the MCP channel ([ADR-0004 (stderr-only-logging)](0004-stderr-only-logging.md)). It never logs a URL with a token or any config value ([ADR-0003 (no-secrets-in-source)](0003-no-secrets-in-source.md)); it holds neither.
   - On an unsupported platform, a missing release, a failed download or a checksum mismatch, exits non-zero with a message that names the cause and the manual route (download the binary, check it against `SHA256SUMS`, set `LOGSEQ_MCP_BINARY`).
7. **The plugin** starts the launcher: `.claude-plugin/plugin.json` runs `node` on it, through `${CLAUDE_PLUGIN_ROOT}`. The binary isn't in git, and a marketplace install of any commit works as soon as the release of that commit's version is published. No npm publish is needed.
8. **The npm package** keeps the name `logseq-mcp-server`. Nothing was ever published, so there is no installed base, no deprecation and no rename. It becomes the launcher package: its `bin` entries (`logseq-mcp-server` and the older `logseq-mcp`) point at the launcher, and `files` lists the launcher, `skills`, `CHANGELOG.md`, `LICENSE` and `README.md`. `dist`, `main`, the `build` script and `prepublishOnly` go. `publish.yml` stays a manual, `main`-only workflow with `dry_run` defaulting to true (ADR-0017), and now packs and publishes the launcher package. It refuses to publish a version whose GitHub Release isn't published yet, so a package never points at assets that don't exist. npm is the second channel: the first release doesn't wait for it, and publishing to npm is the maintainer's separate, later choice.
9. **One version.** The number in `rust/Cargo.toml` is the version the binary reports as `serverInfo.version`. It, `package.json`, `.claude-plugin/plugin.json` and the marketplace entry are equal, held by the version test that already exists. The first release is `1.0.0`, which is what all four say today. No `1.0.0` was ever published from the TypeScript server, so the number isn't reused. A release is cut by a PR that bumps the four together, then a run of `release.yml` at that version. Versions follow semver, with the tool contract's additive-only rule ([BR-0004 (additive-tool-contracts)](../business-rules/0004-additive-tool-contracts.md)) deciding minor against major. The launcher fetches exactly the version its own package says, never "latest", so the launcher and the binary can't drift apart.
10. **The first release is a manual step by the maintainer.** In this order, none of it from a session:
    1. The cutover is on `main` (#354).
    2. The release task (#355 and the build-matrix task that follows this ADR) is merged.
    3. The maintainer runs `release.yml` with `dry_run` on, and reads the artifacts.
    4. The maintainer runs it again with `dry_run` off, reads the draft release (assets, `SHA256SUMS`, attestations), and installs the plugin from it on a clean macOS machine and a clean Linux machine, calling one tool.
    5. The maintainer publishes the release, which creates the tag.
    6. Only then, if they choose, the maintainer runs `publish.yml` with `dry_run` on, then off.

    CLAUDE.md's rule that nothing is published, tagged or released from a session is unchanged and applies to every step above.

### Alternatives rejected

- **Option 2, per-platform npm packages with optional dependencies.** It needs one launcher package and one package per platform, each published by hand with provenance, and a scope or organization created in the maintainer's npm account. The plugin would then depend on an npm publish, which ADR-0018 already named as a cost. It still needs Node at runtime for the shim. Its real upside is that the first run needs no network and the registry vouches for the files. This option isn't ruled out later: the launcher could prefer an installed platform package, and that is additive.
- **Option 3, a binary-only plugin.** It needs no Node and no network at run time. But committed binaries (about 3 to 4 MB each, times targets, times releases) stay in git history for good, or a CI job has to write to a release branch, which is a push no session may make. It still needs a platform picker, and a shell script isn't portable to Windows. The plugin at `main` would hold no binary. Revisit this if Claude Code adds platform-specific plugin files or a download step of its own.
- **Option 4, `cargo install` only.** It needs a Rust toolchain (1.88, pinned) and a build of a few minutes, and it is a poor fit for a plugin. It stays as a documented path for developers.
- **A shell or PowerShell installer** (`curl | sh`). It pipes remote code into a shell and splits into two scripts, one of which can't be the plugin's single command.
- **A release tool such as `cargo-dist`.** It is a new tool to vet for a four-job matrix. A hand-written workflow is easier to read against ADR-0017's rules. Revisit if the matrix grows.
- **Building on every merge or tag.** That publishes without a deliberate choice at that moment, which ADR-0017 rejected.
- **A fallback to the TypeScript server for one release.** The Go on #349 retired it (#356), and nothing in this decision brings it back.

## Consequences

- **A user needs Node to start the server**, and that Node process stays resident next to the binary. That costs part of the footprint gain the port was for: the 9 ms start and the 2 MB resident figures describe the binary alone. The saving that remains is the install (about 3 to 4 MB against about 140 MB, and no `node_modules`) and the server's own memory and start-up. #355 measures the launched server with `scripts/measure-footprint.ts` and says so in its PR. Removing the Node requirement is the reason to revisit option 3.
- **The first run needs the network**, for a few MB from `github.com`, and fails with a clear message when it can't get them. `LOGSEQ_MCP_BINARY` is the offline path. Later runs read the cache.
- **The plugin and the release can disagree for a short time.** The marketplace entry is the repository's default branch, so a bump of the four version numbers merged before the release is published makes the plugin ask for assets that don't exist yet, and the launcher fails with the version it wanted. The release process keeps the window short by running `release.yml` right after the bump merges and publishing the draft in the same sitting. Nothing in the launcher guesses an older release.
- **Windows users have no binary in the first release.** That is a real gap for LogSeq's Windows users. It is stated, so it isn't a surprise, and the route to close it (local time on Windows, then a gate) is named.
- **macOS binaries aren't notarized.** Anyone who downloads one in a browser meets a Gatekeeper warning until they clear the quarantine attribute. The launcher path avoids it, to be confirmed on a clean machine in step 10.4.
- **The release workflow can't be fully tested without making a release.** Its first dry run on GitHub is the real test, as ADR-0017 found for npm. The draft step is what keeps the first real run recoverable: a draft can be deleted, and a published npm version can't.
- **GitHub's Intel macOS runners are on a retirement path.** `macos-15-intel` is the only runner that runs an x86_64 macOS binary natively. When it goes, the `x86_64-apple-darwin` job cross-compiles from the arm64 runner and its gate runs under Rosetta or not at all. That is a later decision, and it is a reason to check before relying on the runner name.
- **ADR-0017 and ADR-0018 stay as written.** This ADR keeps ADR-0017's rule (manual, `main` only, dry run by default, never from a session) and applies it to the new workflow, and it replaces what `publish.yml` publishes, not who starts it. ADR-0018's plugin layout and its skills decision stand, and only the server command changes. Their enforcement sections already say the packaging is open, and #355 updates them when it lands. The maintainer may prefer to mark ADR-0017 superseded by this ADR in #355's PR, since its Decision text names the TypeScript build.
- **More to maintain**: a launcher with tests, a second workflow, checksums and attestations, and a licence-notice step. The workflow's cost is about 2 to 7 minutes of job time per target on a cold cache (#304), paid only on a release.

## Status

proposed

Date: 2026-10-08

## Mechanical enforcement

- test: `tests/rust-guards/version.test.ts` (the server reports the version in `rust/Cargo.toml`, and the package, the plugin manifest and the marketplace entry equal it)
- test: `tests/guards/adr-workflow-guards.test.ts` (publish.yml triggers only on workflow_dispatch, defaults dry_run to true and is gated to main, and no other workflow runs npm publish; this holds the manual-publish rule for npm, not for the release workflow)
- none-yet: #350 (the build-matrix task, filed once this ADR is accepted: a guard test that release.yml triggers only on workflow_dispatch, is gated to main, defaults dry_run to true, creates only a draft release, pins its actions by SHA, and that no other workflow creates a release or a tag)
- none-yet: #355 (a launcher unit test: platform mapping, checksum refusal, atomic cache write, nothing on stdout, LOGSEQ_MCP_BINARY; and a guard that plugin.json and package.json bin start the launcher and that no manifest names a dist path)
- reviewer: the first release, its tag and any npm publish are made by the maintainer from the Actions and Releases pages, never from a session (CLAUDE.md, Common Gotchas); a reviewer checks that no PR adds a step that tags, releases or publishes outside the manual workflows
