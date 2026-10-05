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

const TIPS_OFF_VALUES = ['0', 'false', 'off', 'no'];
const TIPS_ON_VALUES = ['1', 'true', 'on', 'yes'];

/**
 * Whether next-step tips (#44) are on. They are on by default; `"tips": false` in
 * the config file turns them off. `LOGSEQ_MCP_TIPS` overrides the file: `off`,
 * `false`, `0` or `no` turn tips off, `on`, `true`, `1` or `yes` turn them on
 * (case-insensitive, surrounding spaces ignored). An empty variable is ignored.
 * Any other value throws, so a typo such as `disabled` can't leave tips on silently.
 */
export function resolveTipsEnabled(
  config: Pick<LogseqMCPConfig, 'tips'>,
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env.LOGSEQ_MCP_TIPS;
  const flag = raw?.trim().toLowerCase();
  if (flag !== undefined && flag !== '') {
    if (TIPS_OFF_VALUES.includes(flag)) return false;
    if (TIPS_ON_VALUES.includes(flag)) return true;
    throw new Error(
      `Configuration validation failed: LOGSEQ_MCP_TIPS must be one of ${[...TIPS_ON_VALUES, ...TIPS_OFF_VALUES].join(', ')} (got "${raw}")`
    );
  }
  return config.tips !== false;
}
