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

    if (config.timeoutMs !== undefined &&
        (typeof config.timeoutMs !== 'number' || !Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) {
      throw new Error('Configuration validation failed: timeoutMs must be a positive finite number');
    }

    if (config.tips !== undefined && typeof config.tips !== 'boolean') {
      throw new Error('Configuration validation failed: tips must be a boolean');
    }

    return {
      apiUrl,
      authToken: config.authToken,
      ...(config.timeoutMs !== undefined && { timeoutMs: config.timeoutMs }),
      ...(config.tips !== undefined && { tips: config.tips })
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

/**
 * Whether next-step tips (#44) are on. They are on by default; `"tips": false` in
 * the config file or `LOGSEQ_MCP_TIPS` set to `0`, `false`, `off` or `no` turns
 * them off. The environment variable wins, so a host can override the file.
 */
export function resolveTipsEnabled(
  config: Pick<LogseqMCPConfig, 'tips'>,
  env: Record<string, string | undefined> = process.env
): boolean {
  const flag = env.LOGSEQ_MCP_TIPS?.trim().toLowerCase();
  if (flag !== undefined && flag !== '') {
    return !['0', 'false', 'off', 'no'].includes(flag);
  }
  return config.tips !== false;
}
