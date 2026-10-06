fixture-version:: 1

- This page marks the folder as the logseq-mcp-server integration-test fixture graph.
- `requireFixtureGraph` in tests/integration/helpers/fixture-graph.ts looks for this page and its fixture-version property before any test reads the graph.
- Bump fixture-version here and FIXTURE_VERSION in that helper together whenever the tests come to depend on new fixture content.
