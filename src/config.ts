import { readFile } from 'fs/promises';
import { LogseqMCPConfig } from './types.js';

/**
 * Load and validate configuration from a JSON file
 * @param configPath - Path to the configuration file
 * @returns Validated configuration object
 * @throws Error if config file doesn't exist, is invalid JSON, or missing required fields
 */
export async function loadConfig(configPath: string): Promise<LogseqMCPConfig> {
  try {
    // Read the config file
    const configData = await readFile(configPath, 'utf-8');

    // Parse JSON
    let config: any;
    try {
      config = JSON.parse(configData);
    } catch (parseError) {
      throw new Error(`Invalid JSON in config file: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
    }

    // Validate required fields
    if (!config.authToken) {
      throw new Error('Configuration validation failed: authToken is required');
    }

    // Apply default for apiUrl if not provided
    const apiUrl = config.apiUrl || 'http://127.0.0.1:12315';

    // Validate types
    if (typeof apiUrl !== 'string') {
      throw new Error('Configuration validation failed: apiUrl must be a string');
    }

    if (typeof config.authToken !== 'string') {
      throw new Error('Configuration validation failed: authToken must be a string');
    }

    return {
      apiUrl,
      authToken: config.authToken,
      features: config.features
    };
  } catch (error) {
    // Re-throw validation errors as-is
    if (error instanceof Error && error.message.includes('Configuration validation')) {
      throw error;
    }
    if (error instanceof Error && error.message.includes('Invalid JSON')) {
      throw error;
    }

    // Handle file not found and other errors
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Configuration file not found: ${configPath}`);
    }

    // Re-throw other errors
    throw error;
  }
}
