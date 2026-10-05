import type { PageCandidate } from './types.js';

/**
 * Custom error classes with helpful guidance for error recovery.
 * Following MCP best practices: errors should guide users toward corrections.
 */

/**
 * Thrown when a name resolves to no page (no exact name, alias, journal date or
 * namespace leaf). The message is guidance: the closest names, then the tools
 * to find the page with.
 */
export class PageNotFoundError extends Error {
  readonly pageName: string;
  readonly suggestions: string[];

  constructor(pageName: string, suggestions: string[] = []) {
    const closest = suggestions.length > 0 ? ` Closest: ${suggestions.join(', ')}.` : '';
    super(
      `No page ${JSON.stringify(pageName)}.${closest} ` +
      `Try logseq_search_blocks to find it by content, or logseq_list_pages (name_contains) to browse names.`
    );
    this.name = 'PageNotFoundError';
    this.pageName = pageName;
    this.suggestions = suggestions;
  }
}

/**
 * Thrown when a name matches several pages (an alias shared by pages, or a
 * namespace leaf name used under several namespaces) and none of them is an
 * exact name match. Nothing is picked: the candidates say how to choose.
 * The MCP layer returns this as a structured result, not an error.
 */
export class AmbiguousPageError extends Error {
  readonly pageName: string;
  readonly candidates: PageCandidate[];
  /** Matching pages in total; more than `candidates.length` when the list was capped */
  readonly totalCandidates: number;
  /**
   * Says that the list was cut at its maximum, that the rest can't be fetched in
   * one call, and how to narrow the search. Set only when
   * `totalCandidates > candidates.length`, so a cut list is never silent.
   */
  readonly truncationNote?: string;

  constructor(pageName: string, candidates: PageCandidate[], totalCandidates = candidates.length) {
    const listed = candidates.map(c => `${JSON.stringify(c.originalName)} (${c.reason})`).join('; ');
    const truncated = totalCandidates > candidates.length;
    const more = truncated ? ` and ${totalCandidates - candidates.length} more` : '';
    const truncationNote = truncated
      ? `Showing ${candidates.length} of ${totalCandidates}, the most this lists; the rest can't be fetched in one call. ` +
        `To narrow it down, call logseq_list_pages with name_contains set to part of the page name you mean, ` +
        `or use its full namespaced name.`
      : undefined;
    super(
      `${JSON.stringify(pageName)} matches ${totalCandidates} pages: ${listed}${more}. ` +
      (truncationNote ? `${truncationNote} ` : '') +
      `Repeat the call with the exact name of one of them.`
    );
    this.name = 'AmbiguousPageError';
    this.pageName = pageName;
    this.candidates = candidates;
    this.totalCandidates = totalCandidates;
    this.truncationNote = truncationNote;
  }
}

/**
 * Thrown when a block is not found by UUID.
 */
export class BlockNotFoundError extends Error {
  constructor(blockUuid: string) {
    super(
      `Block not found: "${blockUuid}"\n\n` +
      `Tip: Block UUIDs come from search results or page queries. Verify the UUID is correct.`
    );
    this.name = 'BlockNotFoundError';
  }
}

/**
 * Thrown when a property query returns no results.
 */
export class PropertyNotFoundError extends Error {
  constructor(propertyKey: string, propertyValue: string) {
    super(
      `No blocks found with property "${propertyKey}" = "${propertyValue}"\n\n` +
      `Tip: Check property spelling and value. Properties are case-sensitive.`
    );
    this.name = 'PropertyNotFoundError';
  }
}

/**
 * Thrown when a parameter has an invalid format.
 */
export class InvalidParameterError extends Error {
  constructor(paramName: string, value: any, expected: string, example?: string) {
    const exampleText = example ? `\nExample: ${example}` : '';
    super(
      `Invalid parameter '${paramName}': ${value}\n\n` +
      `Expected: ${expected}${exampleText}`
    );
    this.name = 'InvalidParameterError';
  }
}

/**
 * Thrown when LogSeq is not running or the HTTP API is not enabled.
 */
export class LogSeqNotRunningError extends Error {
  constructor(apiUrl: string, originalError?: Error) {
    const errorDetails = originalError ? `\n\nError: ${originalError.message}` : '';
    super(
      `Cannot connect to LogSeq at ${apiUrl}${errorDetails}\n\n` +
      `Steps to fix:\n` +
      `1. Start LogSeq desktop application\n` +
      `2. Enable HTTP API server: Settings → Advanced → Enable HTTP API server\n` +
      `3. Verify API URL in ~/.logseq-mcp/config.json matches LogSeq's HTTP server port`
    );
    this.name = 'LogSeqNotRunningError';
  }
}

/**
 * Thrown when a LogSeq API call does not complete within the configured timeout.
 * LogSeq is reachable but not answering, which is different from LogSeqNotRunningError.
 */
export class LogSeqTimeoutError extends Error {
  constructor(apiUrl: string, timeoutMs: number) {
    super(
      `LogSeq at ${apiUrl} did not respond within ${timeoutMs}ms\n\n` +
      `Steps to fix:\n` +
      `1. Check that LogSeq is not busy (indexing, a stuck window or a very large graph)\n` +
      `2. Retry the request\n` +
      `3. To allow slower calls, raise "timeoutMs" in ~/.logseq-mcp/config.json (default 30000, per API call)`
    );
    this.name = 'LogSeqTimeoutError';
  }
}

/**
 * Thrown when LogSeq rejects the auth token (HTTP 401).
 * The message never includes the token itself.
 */
export class LogSeqAuthError extends Error {
  constructor(apiUrl: string) {
    super(
      `LogSeq at ${apiUrl} rejected the auth token (HTTP 401)\n\n` +
      `Steps to fix:\n` +
      `1. The token is invalid or has been changed. Regenerate it in LogSeq's API settings\n` +
      `2. Update "authToken" in ~/.logseq-mcp/config.json\n` +
      `3. See tests/integration/setup.md for details`
    );
    this.name = 'LogSeqAuthError';
  }
}

/**
 * True for failures of the connection to LogSeq itself (not running, timeout,
 * rejected token). These must never be turned into "no data".
 */
export function isInfrastructureError(error: unknown): boolean {
  return (
    error instanceof LogSeqNotRunningError ||
    error instanceof LogSeqTimeoutError ||
    error instanceof LogSeqAuthError
  );
}
