// Starts the TypeScript server from source, for the parity harness (#124). src/index.ts runs
// main() only when it is the process's entry point, and under vite-node it isn't (argv[1] is
// vite-node itself), so this file calls it.
import { main } from '../../src/index.js';

void main();
