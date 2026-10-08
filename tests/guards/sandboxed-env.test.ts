import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PARITY_NOW_MS, PARITY_TZ, sandboxedEnv } from '../../scripts/lib/sandboxed-env.js';

/** The environment the Node tooling runs the server in (scripts/lib/sandboxed-env.ts). The parity test's is in Rust (rust/tests/parity_harness.rs). */
describe('sandboxedEnv', () => {
  it('gives the server a sandboxed home, so a server that ignores LOGSEQ_MCP_CONFIG finds no fallback config', () => {
    const env = sandboxedEnv('/tmp/logseq-x/config.json', '/tmp/logseq-x/home');
    expect(env.LOGSEQ_MCP_CONFIG).toBe('/tmp/logseq-x/config.json');
    expect(env.HOME).toBe('/tmp/logseq-x/home');
    expect(env.HOME).not.toBe(homedir());
    expect(env.USERPROFILE).toBe(env.HOME);
    expect(env.XDG_CONFIG_HOME).toBe(join(env.HOME, '.config'));
    expect(env.CFFIXED_USER_HOME).toBe(process.platform === 'darwin' ? env.HOME : process.env.CFFIXED_USER_HOME);
  });

  it('fixes the clock and the time zone, so a result that depends on today is the same on every day (#311)', () => {
    const env = sandboxedEnv('/tmp/c.json', '/tmp/h');
    expect(env.LOGSEQ_MCP_NOW).toBe(String(PARITY_NOW_MS));
    expect(env.TZ).toBe(PARITY_TZ);
    // 03:30 UTC on the 12th is 23:30 on the 11th in New York (daylight saving began on the 9th)
    expect(new Date(PARITY_NOW_MS).toISOString()).toBe('2025-03-12T03:30:00.000Z');
    expect(new Date(PARITY_NOW_MS).toLocaleDateString('en-CA', { timeZone: PARITY_TZ })).toBe('2025-03-11');
    expect(sandboxedEnv('/tmp/c.json', '/tmp/h', 5).LOGSEQ_MCP_NOW).toBe('5');
  });

  it('leaves tips at their default, whatever the caller had set', () => {
    process.env.LOGSEQ_MCP_TIPS = 'off';
    try {
      expect(sandboxedEnv('/tmp/c.json', '/tmp/h').LOGSEQ_MCP_TIPS).toBeUndefined();
    } finally {
      delete process.env.LOGSEQ_MCP_TIPS;
    }
  });
});
