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

import type { OpenPrInput, OpenPrResult } from './port.js';

const execFileAsync = promisify(execFile);

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

export async function openPr(input: OpenPrInput): Promise<OpenPrResult> {
  const { cwd, branch, title } = input;
  const remote = input.remote ?? 'origin';

  assertSafeRef('branch', branch);
  assertSafeRef('remote', remote);
  if (input.base) assertSafeRef('base', input.base);

  // 1. Push the branch and set upstream. `--` terminates option parsing so the
  //    validated remote/branch can never be treated as flags (belt-and-suspenders).
  await execFileAsync('git', ['push', '--set-upstream', '--', remote, branch], { cwd });

  // 2. gh pr create. Use a temp body file so multiline Markdown is preserved
  //    exactly (the vendored handler does the same).
  const ghArgs = ['pr', 'create', '--title', title, '--head', branch];
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
    const { stdout, stderr } = await execFileAsync('gh', ghArgs, { cwd });
    const out = `${stdout ?? ''}\n${stderr ?? ''}`;
    const match = out.match(PR_URL_RE);
    if (!match) {
      throw new Error(`open-pr: could not parse a PR URL from gh output:\n${out.trim()}`);
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
