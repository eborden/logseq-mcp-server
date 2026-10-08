// The command line of scripts/parity.ts, parsed apart from the script so a test can reach it
// (the script runs `main()` when it is loaded).
import type { ServerCommand } from './harness.js';
import { rustServer } from './server-command.js';

export const USAGE =
  'usage: npx tsx scripts/parity.ts [--perturb | --self-check] [-- <server command> [args...]]\n' +
  '       npx tsx scripts/parity.ts --tested-tools-only -- <server command> [args...]   (a server with only some tools, for local use)\n' +
  '       npx tsx scripts/parity.ts --real-clock -- <server command> [args...]   (a server that reads the system clock, like the Rust release build: the cases that read today are left out)\n' +
  "       npx tsx scripts/parity.ts --record-from-rust  (this checkout's debug build only; review the JSON diff; never in CI)\n" +
  "With no command, the server is this checkout's debug build: rust/target/debug/logseq-mcp-server (cd rust && cargo build).";

export function parseCommandLine(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): {
  mode: 'check' | 'record' | 'perturb' | 'self-check';
  server: ServerCommand;
  onlyTestedTools: boolean;
  realClock: boolean;
} {
  // The command follows `--`. vite-node, which CI runs this with from the lockfile, swallows every
  // `--` before the script sees its arguments, so without one the command starts at the first
  // argument that is not a flag.
  const dashes = argv.indexOf('--');
  const bare = argv.findIndex(arg => !arg.startsWith('-'));
  const commandAt = dashes !== -1 ? dashes + 1 : bare;
  const allFlags = dashes !== -1 ? argv.slice(0, dashes) : bare === -1 ? argv : argv.slice(0, bare);
  const onlyTestedTools = allFlags.includes('--tested-tools-only');
  const realClock = allFlags.includes('--real-clock');
  const flags = allFlags.filter(flag => flag !== '--tested-tools-only' && flag !== '--real-clock');
  const command = commandAt === -1 ? [] : argv.slice(commandAt);
  const modes = flags.map(flag => {
    if (flag === '--record-from-rust') return 'record' as const;
    if (flag === '--perturb') return 'perturb' as const;
    if (flag === '--self-check') return 'self-check' as const;
    if (flag === '--record') {
      throw new Error(
        `--record recorded from the TypeScript server, which is retired (#356); to record the expected results again from the Rust server on purpose, use --record-from-rust\n${USAGE}`
      );
    }
    throw new Error(`unknown flag ${flag}\n${USAGE}`);
  });
  if (modes.length > 1) throw new Error(`pick one mode\n${USAGE}`);
  if (dashes !== -1 && command.length === 0) throw new Error(`no server command after --\n${USAGE}`);
  if (modes[0] === 'record') {
    // The recorded results are the reference every server is judged against (#299 changes them on purpose, with a
    // reviewed diff). They are never written by a candidate of the reader's choosing, by a build that ignores the test
    // clock, from a partial run or by CI, so a run that goes wrong can't rewrite the golden files unnoticed.
    if (command.length > 0) {
      throw new Error(`--record-from-rust runs this checkout's debug build only: a candidate can't record its own reference\n${USAGE}`);
    }
    if (onlyTestedTools) {
      throw new Error(`--record-from-rust needs the whole tools/list, so it can't take --tested-tools-only\n${USAGE}`);
    }
    if (realClock) throw new Error(`--record-from-rust needs every case, so it can't take --real-clock\n${USAGE}`);
    if (env.CI) {
      throw new Error(`--record-from-rust is never run in CI: a re-record is done by hand and ships with a reviewed diff of the JSON\n${USAGE}`);
    }
  }
  const server = command.length > 0 ? { command: command[0], args: command.slice(1) } : rustServer();
  return { mode: modes[0] ?? 'check', server, onlyTestedTools, realClock };
}
