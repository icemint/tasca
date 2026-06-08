// Build the non-interactive agent CLI command line for the lifecycle PTY.
//
// The vendored ptyManager takes a single command STRING (it runs it via a
// shell), so each argv element must be POSIX-quoted before joining. The task
// title/body that flow into the prompt are attacker-controlled — they are
// neutralized by `shellQuote` (a single-quoted literal, with embedded quotes
// escaped), exactly as proven by the SC1-7 spike.

/**
 * POSIX single-quote escape: wrap `s` in single quotes and replace each embedded
 * single quote with the `'\''` sequence (close-quote, escaped-quote, re-open).
 * The result is a single shell token whose contents are taken literally, so a
 * value like `'; rm -rf / #` or `$(x)` cannot break out into the command.
 */
export function shellQuote(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// SECURITY (known, tracked): the prompt is built from the attacker-controlled
// issue title/body, and this allowlist grants Bash (+ Read) — so a prompt-injection
// could instruct the agent to read the installation token that clone-on-dispatch
// persists in the worktree's .git/config and exfiltrate it. shellQuote closes the
// command-injection layer, but NOT this prompt→agent→secret path. The real fix is
// credential isolation (don't persist the token where the agent can read it / run
// the agent without git creds) — a separate hardening, deferred. Until then this is
// only safe for TRUSTED repos (single-tenant self-hosting); do not enable for
// untrusted multi-tenant issue authors. Override per deployment via allowedTools.
/** Default tool allowlist for an autonomous run (read + edit + shell + search). */
export const DEFAULT_AGENT_ALLOWED_TOOLS = 'Read,Edit,Write,Bash,Glob,Grep';

/**
 * Cap the prompt size so the assembled command line stays well under the OS
 * execve argument limit (ARG_MAX is ~256KB on Linux; 60K leaves ample room for
 * the surrounding argv and shell quoting overhead).
 */
const MAX_PROMPT_CHARS = 60000;
const TRUNCATION_MARKER = '\n\n[...truncated]';

/**
 * Build the shell command line that runs `claude` non-interactively (`-p` prints
 * and exits) over a single prompt. Permission handling is explicit: by default
 * the run is restricted to an allowlist of tools; `skipPermissions` opts into the
 * fully-autonomous `--dangerously-skip-permissions` mode instead.
 *
 * Every argv element (including the attacker-controlled prompt) is POSIX-quoted,
 * so the returned string is injection-safe to hand to the PTY shell.
 */
export function buildClaudeCommand(opts: {
  prompt: string;
  allowedTools?: string;
  skipPermissions?: boolean;
}): string {
  let prompt = opts.prompt;
  if (prompt.length > MAX_PROMPT_CHARS) {
    prompt = prompt.slice(0, MAX_PROMPT_CHARS) + TRUNCATION_MARKER;
  }

  const argv = ['claude', '-p', prompt, '--output-format', 'text'];
  if (opts.skipPermissions) {
    argv.push('--dangerously-skip-permissions');
  } else {
    argv.push(
      '--allowedTools',
      (opts.allowedTools && opts.allowedTools.trim()) || DEFAULT_AGENT_ALLOWED_TOOLS
    );
  }
  return argv.map(shellQuote).join(' ');
}
