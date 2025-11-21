import { LogseqMCPConfig, LogseqAPIRequest, LogseqAPIResponse } from './types.js';

/**
 * HTTP client for LogSeq API
 * Handles authentication, error handling, and API communication
 */
export class LogseqClient {
  public config: LogseqMCPConfig;

  constructor(config: LogseqMCPConfig) {
    this.config = config;
  }

  /**
   * Call a LogSeq API method
   * @param method - The API method to call (e.g., 'logseq.Editor.getBlock')
   * @param args - Optional array of arguments for the method
   * @returns The response data from the API
   * @throws Error if the API call fails or returns an error
   */
  async callAPI<T = any>(method: string, args: any[] = []): Promise<T> {
    const url = `${this.config.apiUrl}/api`;

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
        body: JSON.stringify(request)
      });

      // Handle HTTP errors
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Parse response - LogSeq returns data directly, not wrapped
      const responseData = await response.json();

      // Check if this is an error response (has error property)
      if (responseData && typeof responseData === 'object' && 'error' in responseData) {
        throw new Error(`LogSeq API error: ${responseData.error}`);
      }

      // Return the data directly (LogSeq doesn't wrap in {data: ...})
      return responseData as T;
    } catch (error) {
      // Handle connection errors (ECONNREFUSED, ETIMEDOUT, etc.)
      if (error instanceof Error && 'code' in error) {
        const errorCode = (error as any).code;
        if (errorCode === 'ECONNREFUSED' || errorCode === 'ETIMEDOUT') {
          throw new Error(`Failed to connect to LogSeq API at ${url}: ${error.message}`);
        }
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Execute a Datalog query via logseq.DB.datascriptQuery
   * @param query - The Datalog query string
   * @returns The query results
   * @throws Error if the query fails
   */
  async executeDatalogQuery<T = any>(query: string): Promise<T> {
    return this.callAPI<T>('logseq.DB.datascriptQuery', [query]);
  }
}
