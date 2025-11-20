import { LogseqMCPConfig, LogseqAPIRequest, LogseqAPIResponse } from './types.js';

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

      // Parse response
      const responseData: LogseqAPIResponse<T> = await response.json();

      // Handle API errors
      if (responseData.error) {
        throw new Error(`LogSeq API error: ${responseData.error.message}`);
      }

      // Return successful data
      return responseData.data as T;
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
}
