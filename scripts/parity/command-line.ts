// The command line of scripts/parity.ts, parsed apart from the script so a test can reach it
// (the script runs `main()` when it is loaded).
import type { ServerCommand } from './harness.js';
import { typescriptServer } from './ts-server.js';

export const USAGE =
  'usage: npx tsx scripts/parity.ts [--perturb | --self-check] [-- <server command> [args...]]\n' +
  '       npx tsx scripts/parity.ts --tested-tools-only -- <server command> [args...]   (a server with only some tools, for local use)\n' +
  '       npx tsx scripts/parity.ts --record   (TypeScript server only; review the JSON diff; never in CI)';

export function parseCommandLine(argv: string[]): {
  mode: 'check' | 'record' | 'perturb' | 'self-check';
  server: ServerCommand;
  onlyTestedTools: boolean;
} {
  // The command follows `--`. vite-node, which CI runs this with from the lockfile, swallows every
  // `--` before the script sees its arguments, so without one the command starts at the first
  // argument that is not a flag.
  const dashes = argv.indexOf('--');
  const bare = argv.findIndex(arg => !arg.startsWith('-'));
  const commandAt = dashes !== -1 ? dashes + 1 : bare;
  const allFlags = dashes !== -1 ? argv.slice(0, dashes) : bare === -1 ? argv : argv.slice(0, bare);
  const onlyTestedTools = allFlags.includes('--tested-tools-only');
  const flags = allFlags.filter(flag => flag !== '--tested-tools-only');
  const command = commandAt === -1 ? [] : argv.slice(commandAt);
  const modes = flags.map(flag => {
    if (flag === '--record') return 'record' as const;
    if (flag === '--perturb') return 'perturb' as const;
    if (flag === '--self-check') return 'self-check' as const;
    throw new Error(`unknown flag ${flag}\n${USAGE}`);
  });
  if (modes.length > 1) throw new Error(`pick one mode\n${USAGE}`);
  if (dashes !== -1 && command.length === 0) throw new Error(`no server command after --\n${USAGE}`);
  if (modes[0] === 'record' && command.length > 0) {
    throw new Error(`--record runs the TypeScript server only: a candidate can't record its own reference\n${USAGE}`);
  }
  if (onlyTestedTools && modes[0] === 'record') {
    throw new Error(`--record needs the whole tools/list, so it can't take --tested-tools-only\n${USAGE}`);
  }
  const server = command.length > 0 ? { command: command[0], args: command.slice(1) } : typescriptServer();
  return { mode: modes[0] ?? 'check', server, onlyTestedTools };
}
