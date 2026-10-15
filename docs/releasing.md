# Releasing

For the maintainer. Nothing releases or publishes automatically, and nothing publishes to npm (ADR-0035). Never publish, tag or release from a session (ADR-0017, carried over by ADR-0035 Decision 10). A release is the native binaries, the three PyPI wheels built from them and `SHA256SUMS` on a GitHub Release, built by a manual workflow (`release.yml`) that runs only when started by hand from the Actions tab, only on `main`, and creates a draft release. You publish the draft yourself, which creates the tag. A second manual workflow (`pypi.yml`, ADR-0036) then uploads the wheels of the public release to PyPI.

The order, from ADR-0035 (Decision 12) and ADR-0036 (Decision 9). Steps 2 and 5 are runs of a workflow from the Actions tab ("Run workflow", branch `main`):

1. Bump the version in `Cargo.toml`, `package.json` and both `.claude-plugin/` manifests together (a test keeps them equal), and move the `CHANGELOG.md` "Unreleased" entries under it with the release date. Merge that first: the release is built at the commit the run starts from.
2. Run `release.yml` with `dry_run` on, read the artifacts and the logs (every leg of the build, and the `wheels` job), then with it off to create the draft.
3. **Pre-publish check.** Draft assets can't be downloaded anonymously, so download them with `gh release download v<version> --dir <empty dir>`. On a clean macOS and a clean Linux machine, run the launcher against that directory and call one tool, then install the wheel for that machine from it (`logseq_mcp_server-<version>-py3-none-<platform>.whl`, one per platform) and call one tool:

   ```bash
   LOGSEQ_MCP_RELEASE_BASE_URL="file://<empty dir>" sh scripts/logseq-mcp-server.sh
   uvx --from <empty dir>/<the wheel for this machine> logseq-mcp-server
   ```

4. Publish the draft. Then, on a clean machine with no override, start the plugin once and call one tool. A bad release is fixed by a new patch version, not an edit.
5. Run `pypi.yml` with `version` set to the release (plain `x.y.z`, no `v`; the release has to be public) and `dry_run` on, read its log (checksums, attestations, the install check), then run it with `dry_run` off and approve the `pypi` environment. PyPI never accepts a file name twice, so a mistake costs a version number.
6. **Post-publish check.** On a clean macOS and a clean Linux machine with no override, run `uvx logseq-mcp-server` through an MCP client and call one tool. A bad upload is fixed by a new patch version, not an edit.

The PyPI long description is `pypi/README.md`, not the root `README.md`. The wheel builder takes it with `--readme pypi/README.md` and freezes it into each wheel at the release's commit, so check it before step 2.
