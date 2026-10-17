// Starts Temporal's dev server (`temporal server start-dev`) through the SDK's own launcher, so no installer
// script is needed: the SDK runs an installed `temporal` CLI when given its path, and otherwise downloads and
// caches the CLI binary itself. The SQLite file keeps workflow history across restarts of the server.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';

export interface DevServerOptions {
  readonly port: number;
  /** SQLite file to persist to; omit for an in-memory server (the crash test). */
  readonly dbFilename?: string | undefined;
  /** Path to an installed `temporal` CLI; omit to let the SDK download and cache one. */
  readonly cliPath?: string | undefined;
}

export async function startDevServer(options: DevServerOptions): Promise<TestWorkflowEnvironment> {
  if (options.dbFilename !== undefined) {
    await mkdir(dirname(options.dbFilename), { recursive: true });
  }
  return await TestWorkflowEnvironment.createLocal({
    server: {
      ip: '127.0.0.1',
      port: options.port,
      ...(options.dbFilename === undefined ? {} : { dbFilename: options.dbFilename }),
      ...(options.cliPath === undefined ? {} : { executable: { type: 'existing-path' as const, path: options.cliPath } }),
    },
  });
}
