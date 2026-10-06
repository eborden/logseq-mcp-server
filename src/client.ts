import { LogseqMCPConfig, LogseqAPIRequest } from './types.js';
import { LogSeqAuthError, LogSeqNotRunningError, LogSeqTimeoutError } from './errors.js';

/** Default per-call timeout when `timeoutMs` is not set in the config */
export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * HTTP client for LogSeq API
 * Handles authentication, error handling, and API communication
 */
export class LogseqClient {
  private config: LogseqMCPConfig;

  constructor(config: LogseqMCPConfig) {
    this.config = config;
  }

  /**
   * Call a LogSeq API method
   * @param method - The API method to call (e.g., 'logseq.Editor.getBlock')
   * @param args - Optional array of arguments for the method
   * @typeParam T - What the caller expects the response to be. It is a claim, not a
   *   check: nothing here validates the response, and `unknown` is the default so a
   *   caller that names no type gets one it must narrow. Tools don't name a shape: they
   *   read through `callParsed` (`src/utils/parse-response.ts`), which checks the response
   *   against a schema from `src/response-schemas.ts`. Read an entity's fields through
   *   `src/utils/entity-fields.ts`, which knows both key spellings.
   * @returns The response data from the API
   * @throws LogSeqAuthError if LogSeq rejects the auth token (HTTP 401)
   * @throws LogSeqTimeoutError if the call exceeds `timeoutMs`
   * @throws Error if the API call fails or returns an error
   */
  async callAPI<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    const url = `${this.config.apiUrl}/api`;
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const request: LogseqAPIRequest = {
      method,
      args
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.authToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request),
        // A fresh signal per call: the timeout bounds each request, not a whole
        // tool run, so tools that make many calls are not cut short.
        signal: AbortSignal.timeout(timeoutMs)
      });

      // A rejected token gets its own actionable error
      if (response.status === 401) {
        throw new LogSeqAuthError(this.config.apiUrl);
      }

      // Handle HTTP errors
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Parse response - LogSeq returns data directly, not wrapped
      const responseData: unknown = await response.json();

      // Check if this is an error response (has error property)
      if (responseData && typeof responseData === 'object' && 'error' in responseData) {
        throw new Error(`LogSeq API error: ${responseData.error}`);
      }

      // Return the data directly (LogSeq doesn't wrap in {data: ...})
      return responseData as T;
    } catch (error) {
      // Handle connection errors (ECONNREFUSED, ETIMEDOUT, etc.)
      if (error instanceof Error) {
        // AbortSignal.timeout() rejects with a TimeoutError DOMException. Check
        // it first so it is never mistaken for a connection failure below.
        if (error.name === 'TimeoutError' || error.name === 'AbortError') {
          throw new LogSeqTimeoutError(this.config.apiUrl, timeoutMs);
        }

        // Check for network/connection errors
        // Node's network errors carry a string `code`; a plain Error has none
        const errorCode = (error as { code?: unknown }).code;
        if (errorCode === 'ECONNREFUSED' ||
            errorCode === 'ETIMEDOUT' ||
            errorCode === 'ENOTFOUND' ||
            error.message.includes('fetch failed') ||
            error.message.includes('ECONNREFUSED')) {
          throw new LogSeqNotRunningError(this.config.apiUrl, error);
        }
      }

      // Re-throw other errors (API errors, JSON parse errors, etc.)
      throw error;
    }
  }

  /**
   * Execute a Datalog query via logseq.DB.datascriptQuery
   *
   * LogSeq reads every input after the query string as EDN, so a bare string
   * would be read as a symbol and match nothing. Each input is therefore sent
   * as `JSON.stringify(value)`: a JSON string literal is a valid EDN string
   * literal, and quotes, backslashes and newlines are escaped for us.
   *
   * @param query - The Datalog query string. Use `:in $ ?a ?b` for parameters.
   * @param inputs - Values bound to the `:in` variables after `$`, in order
   * @typeParam T - What the caller expects the rows to be (a claim, as for {@link callAPI}; tools read
   *   through `queryParsed`, which checks them)
   * @returns The query results
   * @throws Error if the query fails
   */
  async executeDatalogQuery<T = unknown>(query: string, ...inputs: unknown[]): Promise<T> {
    return this.callAPI<T>('logseq.DB.datascriptQuery', [
      query,
      ...inputs.map(value => JSON.stringify(value))
    ]);
  }
}
