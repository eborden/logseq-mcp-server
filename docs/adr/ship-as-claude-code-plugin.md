# Ship the server and skills as a Claude Code plugin with skills at the repo root

## Context

Installing the server meant cloning the repo, building it, wiring up the MCP config by hand and relying on `.claude/skills/logseq-skills/` being picked up from the cloned folder. Issue #14 argued that distribution mattered more than design for tools like this, and asked for a plugin plus marketplace so the server and its skills install together.

The plugin format reads skills from `skills/<name>/SKILL.md` at the plugin root, and a marketplace install copies the plugin into a cache. Skills that named tools with a fixed prefix (`mcp__logseq__logseq_*`) break under a plugin, where the prefix becomes `mcp__plugin_<plugin>_<server>__`.

Alternatives for the MCP declaration were a root `.mcp.json`, as the issue suggested, or declaring the server inline in `plugin.json`. A root `.mcp.json` is also picked up as a project-scoped server whenever someone opens this repository in Claude Code, which would duplicate a user's own `logseq` server.

## Decision

The repository is both a Claude Code plugin and its own marketplace (`.claude-plugin/plugin.json` and `marketplace.json`, with `"source": "./"`). Skills live in the real directory `skills/logseq-skills/`, with a relative symlink at `.claude/skills/logseq-skills`, not the other way around, so the plugin copy keeps the real content. The MCP server is declared inline in `plugin.json`. Skills refer to tools by bare name (`logseq_get_page`), and the hub skill says a host may add a prefix. The manifest holds no secrets, since the server reads `~/.logseq-mcp/config.json`.

## Consequences

- Installation becomes a marketplace add and a plugin install, and skills trigger from the same package as the server.
- Skills work under any host prefix, but a skill can no longer assume a tool's full name.
- The plugin starts the server with `node ${CLAUDE_PLUGIN_ROOT}/dist/index.js`, which needs a built `dist/` that is gitignored, so a marketplace install of an unbuilt checkout has no server. Switching to `npx -y logseq-mcp-server` depends on a publish (see `manual-npm-publish`), which had not happened when this was written.
- Two version numbers (`package.json` and the plugin manifests) have to stay equal.
- The plugin format and its manifest keys are an external contract that can change under us.

## Status

accepted

Date: 2026-10-05

## Mechanical enforcement

- test: `src/version.test.ts` (the plugin manifest and the marketplace entry carry the package.json version)
- test: `src/prompts.test.ts` (prompts name only tools that exist, so a tool rename fails)
