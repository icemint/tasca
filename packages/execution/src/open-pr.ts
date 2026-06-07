// open-PR (PR-creation seam) — pure shell, no Electron, no IPC.
//
// Lifted from the vendored gitIpc.ts PR-create handler: push the branch, then
// `gh pr create`, and parse the PR URL from stdout. The vendored version runs
// inside an Electron ipcMain handler; this is the same mechanism extracted into
// a plain async callable so it can run headless.
//
// Mechanism (matches the vendored handler):
//   1. git push --set-upstream <remote> <branch>
//   2. gh pr create --title <t> --body-file <f> --base <b> --head <branch>
//   3. parse the first https?:// URL from stdout -> PR URL

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { ExecutionError } from './port.js';
import type { OpenPrInput, OpenPrResult } from './port.js';

const execFileAsync = promisify(execFile);

/** Minimal exec surface, injectable so the idempotency path is unit-testable. */
export type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd: string }
) => Promise<{ stdout: string; stderr: string }>;

const PR_URL_RE = /https?:\/\/\S+/;

// Branch/remote names are derived from task labels (port.ts) — i.e. influenced
// input. execFile already defeats shell injection, but git/gh still parse argv:
// a value starting with '-' would be read as an OPTION (--exec=, --receive-pack=).
// Reject anything that isn't a plain ref and never let it start with '-'.
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
function assertSafeRef(kind: string, v: string): void {
  if (!SAFE_REF.test(v) || v.includes('..')) {
    throw new Error(`open-pr: unsafe ${kind} ${JSON.stringify(v)}`);
  }
}

export async function openPr(input: OpenPrInput, exec: ExecFn = execFileAsync): Promise<OpenPrResult> {
  const { cwd, branch, title } = input;
  const remote = input.remote ?? 'origin';
  // The PR head is the deterministic headBranch when given, else the local branch.
  const head = input.headBranch ?? branch;

  assertSafeRef('branch', branch);
  assertSafeRef('head', head);
  assertSafeRef('remote', remote);
  if (input.base) assertSafeRef('base', input.base);

  // 1. Push the local branch to the (possibly deterministic) head ref. `--force`
  //    so a re-drive's diverged commits update the SAME head (and thus the same
  //    PR) rather than being rejected or opening a second PR. `--` terminates
  //    option parsing so the validated refs can never be treated as flags. The
  //    refspec `branch:head` is built from two separately-validated refs.
  const refspec = head === branch ? branch : `${branch}:${head}`;
  try {
    await exec('git', ['push', '--force', '--set-upstream', '--', remote, refspec], { cwd });
  } catch (err) {
    throw new ExecutionError('push', `open-pr: git push failed: ${errText(err).trim()}`, {
      cause: err,
    });
  }

  // 2. gh pr create. Use a temp body file so multiline Markdown is preserved
  //    exactly (the vendored handler does the same).
  const ghArgs = ['pr', 'create', '--title', title, '--head', head];
  if (input.base) {
    ghArgs.push('--base', input.base);
  }

  let bodyFile: string | null = null;
  if (input.body != null) {
    bodyFile = path.join(
      os.tmpdir(),
      `tasca-pr-body-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`
    );
    fs.writeFileSync(bodyFile, input.body, 'utf8');
    ghArgs.push('--body-file', bodyFile);
  } else {
    ghArgs.push('--body', '');
  }

  try {
    let out: string;
    try {
      const { stdout, stderr } = await exec('gh', ghArgs, { cwd });
      out = `${stdout ?? ''}\n${stderr ?? ''}`;
    } catch (err) {
      // Idempotency: GitHub rejects a second open PR for the same head branch, so
      // `gh pr create` fails with "already exists" on a re-drive. That is NOT a
      // failure — return the EXISTING PR rather than throwing (which would churn
      // the task) or risking a duplicate. Re-throw anything that isn't that case.
      const msg = errText(err);
      if (!/already exists/i.test(msg)) {
        throw new ExecutionError('pr-create', `open-pr: gh pr create failed: ${msg.trim()}`, {
          cause: err,
        });
      }
      const existing = await existingPrUrl(exec, cwd, head);
      if (existing) return { url: existing };
      // "already exists" but we couldn't read it back — surface as a pr-create failure.
      throw new ExecutionError('pr-create', `open-pr: gh pr create reported an existing PR but it could not be read back: ${msg.trim()}`, {
        cause: err,
      });
    }
    const match = out.match(PR_URL_RE);
    if (!match) {
      throw new ExecutionError('pr-parse', `open-pr: could not parse a PR URL from gh output:\n${out.trim()}`);
    }
    return { url: match[0] };
  } finally {
    if (bodyFile && fs.existsSync(bodyFile)) {
      try {
        fs.unlinkSync(bodyFile);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/** Extract a string message from an execFile rejection (carries stdout/stderr). */
function errText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return `${e.stderr ?? ''}\n${e.stdout ?? ''}\n${e.message ?? ''}`;
  }
  return String(err);
}

/** Look up the URL of the existing open PR for `branch` (the idempotency fallback). */
async function existingPrUrl(exec: ExecFn, cwd: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await exec(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // empty'],
      { cwd }
    );
    const url = (stdout ?? '').trim().match(PR_URL_RE);
    return url ? url[0] : null;
  } catch {
    return null;
  }
}
