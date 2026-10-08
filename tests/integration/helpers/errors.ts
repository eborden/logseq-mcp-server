/**
 * The errors a tool function in `tools.ts` throws for a tool's error result, so a suite can say
 * `rejects.toBeInstanceOf(PageNotFoundError)`. Each one is built from the server's own message, which `tools.ts`
 * checks word for word against the shape it expects; the classes only name what the message says.
 */

/** `No page "<name>". Closest: a, b. Try logseq_search_blocks ...` */
export class PageNotFoundError extends Error {
  constructor(
    readonly pageName: string,
    readonly suggestions: string[],
    message: string
  ) {
    super(message);
    this.name = 'PageNotFoundError';
  }
}

/** `Block not found: "<uuid>" ...` */
export class BlockNotFoundError extends Error {
  constructor(
    readonly blockUuid: string,
    message: string
  ) {
    super(message);
    this.name = 'BlockNotFoundError';
  }
}

/** `Invalid parameter '<name>': ...` */
export class InvalidParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidParameterError';
  }
}

export interface AmbiguousCandidate {
  name: string;
  originalName: string;
  matchedBy: string;
  reason: string;
  [key: string]: unknown;
}

/** The tool's ambiguous-name result: it names the candidates and picks none. */
export class AmbiguousPageError extends Error {
  constructor(
    readonly pageName: string,
    readonly candidates: AmbiguousCandidate[],
    readonly totalCandidates: number,
    /** The result the server sent, whole */
    readonly result: Record<string, unknown>
  ) {
    super(`Ambiguous page name "${pageName}": ${totalCandidates} candidates`);
    this.name = 'AmbiguousPageError';
  }
}
