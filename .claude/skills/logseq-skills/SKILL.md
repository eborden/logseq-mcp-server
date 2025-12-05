---
name: logseq-skills
description: Use when user asks about tasks, research, notes, or references their LogSeq knowledge graph - provides context building workflows, weekly summaries, and comprehensive MCP tool guidance for querying personal knowledge bases
---

# LogSeq Skills

Comprehensive suite of workflows for querying and analyzing LogSeq knowledge graphs via MCP tools.

## When to Use

Use this skill when:
- User asks about their tasks, TODOs, or what to work on
- User asks "what do I know about X?" or needs research context
- User references their LogSeq notes or knowledge graph
- User wants to explore connections between concepts
- User asks for a weekly summary of journal entries
- User needs temporal analysis of their notes

## Available Resources

### Sub-Skills

**`skills/weekly-summary.md`** - Create structured weekly summaries from journal entries
- Trigger: "summarize my week", "weekly summary", "what did I do this week"
- Generates categorized summary pages following established naming conventions
- Read this when user explicitly requests weekly summaries

### References

**`references/context-builder.md`** - Detailed workflows for context building and research
- 7 comprehensive workflows: research, tasks, stale detection, page context, graph exploration, temporal analysis, smart context building
- Performance tips, common pitfalls, example sessions
- Read this when user asks for research help, task management, or graph exploration

**`references/mcp-tools-reference.md`** - Complete MCP tool documentation
- All 11 LogSeq MCP tools with parameters and examples
- Tool comparison tables and selection guidance
- Read this when verifying tool syntax or discovering capabilities

## Quick Tool Selection

| User Request | Best Approach |
|--------------|---------------|
| "What should I work on?" | Load context-builder.md → Workflow 2 (Task Prioritization) |
| "Summarize my week" | Load skills/weekly-summary.md |
| "What do I know about X?" | Load context-builder.md → Workflow 1 (Research Assistant) |
| "Show connections to X" | Load context-builder.md → Workflow 5 (Graph Exploration) |
| "How did X evolve over time?" | Load context-builder.md → Workflow 6 (Temporal Analysis) |
| "Need tool syntax" | Load mcp-tools-reference.md |

## Loading Instructions

**For research, tasks, or graph queries:**
- Read `references/context-builder.md` for detailed workflow guidance
- Optionally read `references/mcp-tools-reference.md` for tool syntax

**For weekly summaries:**
- Read `skills/weekly-summary.md` for complete workflow
- Optionally read `references/mcp-tools-reference.md` for tool syntax

**For tool verification:**
- Read `references/mcp-tools-reference.md` for parameters and examples

## Core Principles

1. **Start broad, then focus** - Search → Get pages → Follow backlinks
2. **Leverage bidirectional links** - Backlinks reveal hidden context
3. **Multiple indicators** - Check both markers (TODO) and properties (status::doing)
4. **Synthesize, don't dump** - Provide context and recommendations, not raw data
5. **Read-only assistance** - Never modify LogSeq structure without explicit request

## Tool Categories

**Basic Tools (5):** search_blocks, get_page, get_backlinks, get_block, query_by_property
**Graph Traversal (1):** get_concept_network
**Semantic Search (1):** search_by_relationship
**Context Building (2):** build_context, get_context_for_query
**Temporal Query (2):** query_by_date_range, get_concept_evolution

Load `references/mcp-tools-reference.md` for complete tool documentation.
