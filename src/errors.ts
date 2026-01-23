/**
 * Custom error classes with helpful guidance for error recovery.
 * Following MCP best practices: errors should guide users toward corrections.
 */

/**
 * Thrown when a page is not found in the LogSeq graph.
 * Includes fuzzy match suggestions to help correct typos.
 */
export class PageNotFoundError extends Error {
  constructor(pageName: string, suggestions: string[] = []) {
    const guidance = suggestions.length > 0
      ? `\n\nDid you mean one of these?\n${suggestions.map(s => `  - ${s}`).join('\n')}`
      : `\n\nTip: Use logseq_list_pages to discover available pages.`;

    super(`Page not found: "${pageName}"${guidance}`);
    this.name = 'PageNotFoundError';
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
