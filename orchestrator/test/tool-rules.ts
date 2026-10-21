// A small model of how a `Bash(<pattern>)` rule matches a command, for tests that check the allowed and denied lists
// against concrete commands. It is a model: `*` stands for any text and every other character stands for itself, which
// is how the CLI's help and docs describe the rules. Whether the real CLI matches the same commands is the maintainer's
// permission drill (README, "Before the first real run"); these tests keep the lists and the brief consistent with each
// other, and they fail when a rule is widened.

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The pattern of a `Bash(...)` rule, or `undefined` for any other rule. */
export function bashPattern(rule: string): string | undefined {
  const match = /^Bash\((.*)\)$/.exec(rule);
  return match?.[1];
}

export function ruleMatchesCommand(rule: string, command: string): boolean {
  const pattern = bashPattern(rule);
  if (pattern === undefined) {
    return false;
  }
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 's').test(command);
}

/** Allowed when some allow rule matches and no deny rule does (deny beats allow). */
export function commandAllowed(allowed: readonly string[], denied: readonly string[], command: string): boolean {
  return allowed.some((rule) => ruleMatchesCommand(rule, command)) && !denied.some((rule) => ruleMatchesCommand(rule, command));
}
