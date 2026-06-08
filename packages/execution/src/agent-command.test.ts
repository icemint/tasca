import { describe, it, expect } from 'vitest';
import { shellQuote, buildClaudeCommand, DEFAULT_AGENT_ALLOWED_TOOLS } from './agent-command.js';

describe('shellQuote', () => {
  it('neutralizes a shell-injection payload into a single-quoted literal', () => {
    const payload = "'; rm -rf / #";
    const quoted = shellQuote(payload);
    // Wrapped as a single token: starts and ends with a single quote.
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // The embedded single quote is escaped via the close/escape/reopen sequence,
    // so the `; rm -rf / #` can never break out of the quoting.
    expect(quoted).toContain("'\\''");
    expect(quoted).toBe(`'`.concat(`'\\''`, '; rm -rf / #', `'`));
  });

  it('quotes command substitution / backticks literally (no expansion)', () => {
    expect(shellQuote('$(x)')).toBe("'$(x)'");
    expect(shellQuote('`x`')).toBe("'`x`'");
  });
});

describe('buildClaudeCommand', () => {
  it('builds a non-interactive claude command with the quoted prompt + default allowlist', () => {
    const cmd = buildClaudeCommand({ prompt: 'do the thing' });
    expect(cmd).toContain("'claude' '-p'");
    expect(cmd).toContain("'do the thing'");
    expect(cmd).toContain("'--output-format' 'text'");
    expect(cmd).toContain("'--allowedTools'");
    expect(cmd).toContain(`'${DEFAULT_AGENT_ALLOWED_TOOLS}'`);
    expect(cmd).not.toContain('--dangerously-skip-permissions');
  });

  it('honors a custom allowedTools value', () => {
    const cmd = buildClaudeCommand({ prompt: 'x', allowedTools: 'Read,Grep' });
    expect(cmd).toContain("'--allowedTools' 'Read,Grep'");
  });

  it('uses --dangerously-skip-permissions when opted in (no allowlist)', () => {
    const cmd = buildClaudeCommand({ prompt: 'x', skipPermissions: true });
    expect(cmd).toContain("'--dangerously-skip-permissions'");
    expect(cmd).not.toContain('--allowedTools');
  });

  it('keeps an injection payload in the prompt quoted (injection-safe)', () => {
    const cmd = buildClaudeCommand({ prompt: "'; rm -rf / #" });
    expect(cmd).toContain("'\\''; rm -rf / #'");
  });

  it('truncates an oversized prompt and appends the marker', () => {
    const big = 'a'.repeat(70000);
    const cmd = buildClaudeCommand({ prompt: big });
    expect(cmd).toContain('[...truncated]');
    // Original full-length run is not present (it was cut to the cap).
    expect(cmd).not.toContain('a'.repeat(70000));
  });
});
