// Helpers shared by the tests that start a real Temporal server.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';

export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  server.close();
  await once(server, 'close');
  return address.port;
}
