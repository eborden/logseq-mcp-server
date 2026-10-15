# The Claude Code plugin

The repo is both a Claude Code plugin and its own marketplace. The plugin bundles the MCP server and the `logseq-skills` workflows.

First set up LogSeq and `~/.logseq-mcp/config.json` ([configuration](configuration.md)). The plugin carries no credentials.

```bash
claude plugin marketplace add eborden/logseq-mcp-server
claude plugin install logseq@logseq-mcp-server
```

The plugin starts `scripts/logseq-mcp-server.sh`, a small POSIX `sh` launcher (ADR-0035). On the first start it downloads the release binary for your platform and for the plugin's own version from [GitHub Releases](https://github.com/eborden/logseq-mcp-server/releases), checks each download against the release's `SHA256SUMS` (it never runs a freshly downloaded file that doesn't match), caches it and replaces itself with the server. Later starts run the cached binary as it sits, without checking it again. Everything it says goes to stderr, since stdout is the MCP channel.

- **Platforms:** macOS (Apple silicon and Intel) and Linux x86_64. Windows and Linux arm64 have no release binary yet; build from a clone and use `LOGSEQ_MCP_BINARY` below.
- **Needs:** `sh`, `curl`, and `shasum` or `sha256sum`. No Node. The first start needs the network (a few MB from `github.com`); a proxy is read from `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY`.
- **Cache:** `~/Library/Caches/logseq-mcp-server/<version>/` on macOS, `~/.cache/logseq-mcp-server/<version>/` elsewhere (`XDG_CACHE_HOME` replaces the parent, and must be an absolute path). It holds the binary, `SHA256SUMS`, `LICENSE` and `THIRD-PARTY-NOTICES.txt`, created readable by you only (0700 and 0600). Because a cached binary is trusted as it sits and is not re-checked, the launcher refuses a cache directory that someone else owns or that group or others can write to. The check follows symlinks and tests the effective user, so it fails closed on purpose in two cases: a `sudo` or root run that keeps your `HOME`, and an NFS mount that maps owners differently. Both refusals name `XDG_CACHE_HOME`; point it at a directory of your own. A start that was killed hard can leave a `.partial.*` directory in it; the next download removes the ones over a day old, and nothing in them is ever run.
- **Trust limits:** `SHA256SUMS` comes from the same release as the binary, so the check catches a corrupt or truncated download but not a compromised release or account (ADR-0035 Decision 4). The launcher doesn't verify a signature or an attestation; to tie a binary to the workflow run and commit that built it, run `gh attestation verify <binary> --repo eborden/logseq-mcp-server` by hand.

Two environment variables, set where the plugin's server starts, change where the binary comes from:

| Variable | Effect |
|---|---|
| `LOGSEQ_MCP_BINARY` | An absolute path to a server binary to run as it is: no download, no checks. For offline use, or a binary you built (`cd rust && cargo build --release --locked`). |
| `LOGSEQ_MCP_RELEASE_BASE_URL` | Where the release files are fetched from, in place of `https://github.com/eborden/logseq-mcp-server/releases/download/v<version>`. An `https://`, `http://` or `file://` base. The checksum checks still run, but over plain `http://` the checksums come from the same unprotected place as the binary, so they prove nothing against an attacker on the network (the launcher warns on stderr). |

To use a clone's plugin with your own build, with no download:

```bash
git clone https://github.com/eborden/logseq-mcp-server
cd logseq-mcp-server/rust && cargo build --release --locked && cd ..
LOGSEQ_MCP_BINARY="$PWD/rust/target/release/logseq-mcp-server" claude --plugin-dir .
```

A binary you download by hand through a browser is quarantined by macOS, and Gatekeeper refuses it until you run `xattr -d com.apple.quarantine <file>`. The launcher's `curl` download isn't affected.

Under a plugin, the tools appear as `mcp__plugin_logseq_logseq__logseq_*`. The skills refer to them by bare name, so either form works.
