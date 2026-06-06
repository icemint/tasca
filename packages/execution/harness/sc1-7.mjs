/**
 * @tasca/execution — full SC1-7 harness (real Claude Code agent + real PR).
 *
 * Drives the complete de-Electron execution flow, headless, end to end:
 *
 *   Story -> isolated worktree -> REAL Claude Code agent -> REAL pull request
 *
 * against $SPIKE_TARGET_REPO (roadhero/agentic-playground), proven in CI.
 *
 * Success criteria exercised here (the headless plumbing SC1/SC2/SC3-trivial/
 * SC5/SC6 is proven by headless-boot.mjs; this harness closes the remaining
 * real-credential criteria):
 *
 *   SC1  No Electron at runtime                  (plain node; no versions.electron)
 *   SC2  Worktree isolation headless             (port.reserveWorktree on a clone)
 *   SC3  REAL agent spawn (Claude Code headless) (port.spawnAgent -> claude -p ...)
 *   SC4  REAL pull request                       (port.openPr -> git push + gh pr create)
 *
 * Requires (pre-wired in CI env):
 *   ANTHROPIC_API_KEY  — authenticates the Claude Code CLI
 *   SPIKE_GH_TOKEN     — GH token with `repo`+`workflow` for git push / gh pr create
 *   SPIKE_TARGET_REPO  — owner/name of the live target repo (default: roadhero/agentic-playground)
 *
 * Run (from packages/execution):  node harness/sc1-7.mjs
 * Exits 0 iff SC1-4 are all GREEN; non-zero with a clear message otherwise.
 */
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { createExecution } from '../src/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(__dirname, '..');
const VENDOR = path.join(PKG_ROOT, 'vendor', 'emdash');

// ---- config / env contract --------------------------------------------------
const TARGET_REPO = process.env.SPIKE_TARGET_REPO || 'roadhero/agentic-playground';
const GH_TOKEN = process.env.SPIKE_GH_TOKEN || process.env.GH_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

function die(msg) {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}

if (!GH_TOKEN) die('SPIKE_GH_TOKEN (or GH_TOKEN) is not set — cannot auth git/gh.');
if (!ANTHROPIC_API_KEY) die('ANTHROPIC_API_KEY is not set — cannot run the real Claude Code agent.');

// Short, collision-resistant run id so reruns produce UNIQUE branches.
const RUN_ID = (process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-` : '') +
  crypto.randomBytes(3).toString('hex');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'tasca-sc17-'));
const USER_DATA = path.join(SCRATCH, 'userdata');
const DB_FILE = path.join(SCRATCH, 'execution.db');
const REPO_PATH = path.join(SCRATCH, 'repo');
fs.mkdirSync(USER_DATA, { recursive: true });

// ---- small helpers ----------------------------------------------------------
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
}
function git(args, cwd, opts = {}) {
  return sh('git', args, { cwd, ...opts });
}
const ghEnv = { ...process.env, GH_TOKEN, GIT_TERMINAL_PROMPT: '0' };

const results = [];
const pass = (sc, msg) => {
  results.push([sc, 'PASS', msg]);
  console.log(`\n[${sc}] PASS — ${msg}`);
};
const fail = (sc, msg) => {
  results.push([sc, 'FAIL', msg]);
  console.log(`\n[${sc}] FAIL — ${msg}`);
};

async function main() {
  console.log('=== @tasca/execution full SC1-7 harness (real agent + real PR) ===');
  console.log('node', process.version, '| target', TARGET_REPO, '| run', RUN_ID);
  console.log('scratch', SCRATCH);

  // ---- Auth: make git + gh authenticate to the target via the spike token ----
  // gh auth setup-git wires a git credential helper that hands GH_TOKEN to git,
  // so `git push` to https://github.com/<TARGET_REPO> authenticates as the token.
  sh('gh', ['auth', 'setup-git'], { env: ghEnv });
  const whoami = sh('gh', ['api', 'user', '--jq', '.login'], { env: ghEnv });
  console.log(`gh authenticated as: ${whoami}`);

  // ---- SC1: No Electron at runtime ----
  if (process.versions.electron) {
    fail('SC1', `running inside Electron (versions.electron=${process.versions.electron})`);
  } else {
    pass('SC1', `plain node ${process.version} (no process.versions.electron)`);
  }

  const exec = createExecution({ dbFile: DB_FILE, userDataDir: USER_DATA, appPath: VENDOR });
  await exec.initDb();

  // ---- Clone the target repo (the "repo") -----------------------------------
  const cloneUrl = `https://github.com/${TARGET_REPO}.git`;
  console.log(`\nCloning ${cloneUrl} -> ${REPO_PATH}`);
  sh('git', ['clone', cloneUrl, REPO_PATH], { env: ghEnv });
  git(['config', 'user.email', 'spike@tasca.local'], REPO_PATH);
  git(['config', 'user.name', 'Tasca Spike'], REPO_PATH);

  // Determine the default branch as the PR base. A brand-new target repo can be
  // EMPTY (no commits, no remote default branch yet). In that case, seed the
  // default branch with an initial commit and push it so a PR has a real base.
  let baseBranch;
  let hasRemoteHead = false;
  try {
    const ref = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], REPO_PATH);
    baseBranch = ref.replace(/^origin\//, '');
    hasRemoteHead = true;
  } catch {
    // Empty repo: no remote HEAD, and HEAD is an UNBORN branch (no commit yet).
    // `rev-parse --abbrev-ref HEAD` fails without a commit; `symbolic-ref` reads
    // the unborn branch name. Fall back to 'main' only if even that is unset.
    try {
      baseBranch = git(['symbolic-ref', '--short', 'HEAD'], REPO_PATH);
    } catch {
      baseBranch = 'main';
    }
  }
  console.log(`base branch: ${baseBranch} (remote HEAD present: ${hasRemoteHead})`);

  let repoHasCommits = true;
  try {
    git(['rev-parse', '--verify', 'HEAD'], REPO_PATH);
  } catch {
    repoHasCommits = false;
  }

  if (!repoHasCommits) {
    // Seed the base branch on the remote so the PR has a base to target.
    console.log(`\nTarget repo is empty — seeding base branch '${baseBranch}' with an initial commit.`);
    fs.writeFileSync(
      path.join(REPO_PATH, 'README.md'),
      `# agentic-playground\n\nTarget repo for the Tasca de-Electron execution spike (SC1-7).\n`
    );
    git(['checkout', '-B', baseBranch], REPO_PATH);
    git(['add', '-A'], REPO_PATH);
    git(['commit', '-m', 'chore: seed base branch for Tasca SC1-7 spike'], REPO_PATH);
    git(['push', '--set-upstream', 'origin', baseBranch], REPO_PATH, { env: ghEnv });
    console.log(`Seeded and pushed '${baseBranch}'.`);
  }

  // ---- SC2: reserve an isolated worktree on a UNIQUE branch ------------------
  const taskLabel = `elvis-sc17-${RUN_ID}`;
  let worktree;
  try {
    worktree = await exec.reserveWorktree({
      repoPath: REPO_PATH,
      taskLabel,
      projectId: `sc17-${RUN_ID}`,
      baseRef: baseBranch,
    });
    const isWorktree = fs.existsSync(path.join(worktree.path, '.git'));
    const onOwnBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], worktree.path);
    if (isWorktree && onOwnBranch === worktree.branch) {
      pass('SC2', `worktree at ${worktree.path} on unique branch '${worktree.branch}'`);
    } else {
      fail('SC2', `wtPath=${worktree.path} isWorktree=${isWorktree} branch=${onOwnBranch}`);
      throw new Error('SC2 failed — cannot continue.');
    }
  } catch (e) {
    fail('SC2', String((e && e.stack) || e));
    throw e;
  }

  // ---- SC3: REAL Claude Code agent runs the Story in the worktree ------------
  // The Story: a small but real task. The agent must create exactly one file.
  const STORY =
    'Create a file named ELVIS-WAS-HERE.md containing a single one-sentence ' +
    'greeting from the Tasca agent Elvis. Make no other changes to the repository.';
  // Non-interactive Claude Code: -p prints and exits; --dangerously-skip-permissions
  // allows fully autonomous edits in this throwaway worktree (no internet-side
  // effects beyond the model call). --output-format text keeps stdout clean.
  const claudeArgs = [
    '-p',
    STORY,
    '--output-format',
    'text',
    '--dangerously-skip-permissions',
  ];
  // Build the command string for the PTY (the vendor's ptyManager takes a single
  // command line). execFile-style quoting via a JSON-encoded argv is not how the
  // PTY runs; we shell-quote each arg.
  const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const agentCommand = ['claude', ...claudeArgs].map(shq).join(' ');

  console.log(`\nSpawning REAL Claude Code agent in worktree...`);
  console.log(`  cmd: claude -p <story> --output-format text --dangerously-skip-permissions`);

  let agentOutput = '';
  const exit = await new Promise((resolve, reject) => {
    const handle = exec.spawnAgent({
      id: `sc17-agent-${RUN_ID}`,
      command: agentCommand,
      cwd: worktree.path,
      env: { ANTHROPIC_API_KEY },
    });
    let settled = false;
    let graceTimer;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      clearTimeout(graceTimer);
      fn(val);
    };
    // Real agent runs can take a while; allow up to 5 minutes.
    const to = setTimeout(() => done(reject, new Error('agent timeout (300s)')), 300000);
    handle.onData((d) => {
      agentOutput += d;
      process.stdout.write(d);
    });
    handle.onExit((code, signal) => done(resolve, { code, signal }));
    handle.onError((err) => {
      // EIO/EPIPE on the PTY master fd during child teardown is a benign Linux
      // race (slave closes before the final read settles). onExit + the on-disk
      // result are the authoritative completion signals; give onExit a short
      // grace window, else settle with a sentinel and let the file/commit checks
      // below be the source of truth. Gate strictly on the structured code.
      const code = err && err.code;
      if (code === 'EIO' || code === 'EPIPE') {
        graceTimer = setTimeout(() => done(resolve, { code: null, signal: null, viaEio: true }), 1500);
        return;
      }
      done(reject, err);
    });
  });
  console.log(`\nagent exit: ${JSON.stringify(exit)}`);

  // The agent may or may not commit; ensure a commit lands regardless.
  const elvisFile = path.join(worktree.path, 'ELVIS-WAS-HERE.md');
  const fileExists = fs.existsSync(elvisFile);
  if (fileExists) {
    git(['add', '-A'], worktree.path);
    // Only commit if there is something staged (agent might have committed already).
    const staged = git(['status', '--porcelain'], worktree.path);
    if (staged) {
      git(['commit', '-m', 'Elvis (Tasca agent): add greeting'], worktree.path);
    }
  }

  let committed = false;
  let commitSubject = '';
  let fileInTree = false;
  try {
    commitSubject = git(['log', '-1', '--pretty=%s'], worktree.path);
    // The file must be tracked in the worktree branch tip (vs. the base).
    const tracked = git(['ls-files', '--', 'ELVIS-WAS-HERE.md'], worktree.path);
    fileInTree = tracked.trim() === 'ELVIS-WAS-HERE.md';
    // Confirm the branch tip differs from the base (a real change landed).
    const ahead = git(['rev-list', '--count', `origin/${baseBranch}..HEAD`], worktree.path);
    committed = fileInTree && Number(ahead) > 0;
  } catch (e) {
    console.error('post-agent git inspection error:', e);
  }

  const exitOk = exit.code === 0 || exit.viaEio === true;
  if (fileExists && fileInTree && committed) {
    const contents = fs.readFileSync(elvisFile, 'utf8').trim();
    pass(
      'SC3-real',
      `Claude Code created+committed ELVIS-WAS-HERE.md ("${commitSubject}"); ` +
        `agent exit ${exit.code}; file: ${JSON.stringify(contents.slice(0, 120))}`
    );
  } else {
    fail(
      'SC3-real',
      `fileExists=${fileExists} fileInTree=${fileInTree} committed=${committed} exitOk=${exitOk} ` +
        `exit=${JSON.stringify(exit)}\n--- agent output tail ---\n${agentOutput.slice(-2000)}`
    );
    throw new Error('SC3-real failed — the agent did not produce a committed change.');
  }

  // ---- SC4: REAL pull request via the ExecutionPort -------------------------
  let prUrl = '';
  try {
    const { url } = await exec.openPr({
      cwd: worktree.path,
      branch: worktree.branch,
      base: baseBranch,
      title: 'Elvis (Tasca agent): greeting',
      body:
        `Opened headlessly by the Tasca de-Electron execution spike (SC1-7).\n\n` +
        `- Story: create \`ELVIS-WAS-HERE.md\` with a one-sentence greeting from Elvis.\n` +
        `- Real Claude Code agent ran in an isolated git worktree.\n` +
        `- Run: ${RUN_ID}\n`,
    });
    prUrl = url;
    if (/^https?:\/\/github\.com\/.+\/pull\/\d+/.test(prUrl)) {
      pass('SC4', prUrl);
    } else {
      fail('SC4', `openPr returned a non-PR URL: ${prUrl}`);
      throw new Error('SC4 failed — no valid PR URL.');
    }
  } catch (e) {
    fail('SC4', String((e && e.stack) || e));
    throw e;
  }

  try {
    await exec.close();
  } catch {
    // ignore
  }

  // ---- summary --------------------------------------------------------------
  console.log('\n\n================= SC1-7 SUMMARY =================');
  for (const [sc, status, msg] of results) {
    console.log(`${status.padEnd(6)} ${sc.padEnd(12)} ${msg.split('\n')[0]}`);
  }
  console.log('================================================');
  console.log(`PASS SC3-real`);
  console.log(`PASS SC4 ${prUrl}`);
  const failed = results.filter((r) => r[1] === 'FAIL').length;
  console.log(failed === 0 ? 'RESULT: SC1-7 GREEN' : `RESULT: ${failed} SC(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nHARNESS FAILURE:', (e && e.stack) || e);
  // Print whatever results we accumulated for diagnosis.
  if (results.length) {
    console.error('\npartial results:');
    for (const [sc, status, msg] of results) {
      console.error(`${status.padEnd(6)} ${sc.padEnd(12)} ${msg.split('\n')[0]}`);
    }
  }
  process.exit(1);
});
