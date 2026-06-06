'use strict';
/**
 * Vendor bridge — loads the compiled, Electron-free vendor modules behind the
 * bootstrap shim and exposes only the three services the ExecutionPort needs:
 *
 *   - worktreeService      (reserve/create isolated worktree)
 *   - ptyManager           (startLifecyclePty — onData/onExit transport)
 *   - databaseService      (initialize + close the local SQLite store)
 *   - createDrizzleClient  (fresh DB client, for callers that need raw access)
 *
 * Requiring this installs the path-alias + electron-stub resolve hook first
 * (via bootstrap.cjs), then loads the compiled CommonJS from <vendor>/dist/main.
 * Keeping this as a thin .cjs file isolates the untyped vendor surface from the
 * strict typecheck applied to src/*.ts.
 */
const path = require('path');

const { mainBase } = require('./bootstrap.cjs');
const load = (rel) => require(path.join(mainBase, rel));

function getServices() {
  const { worktreeService } = load('services/WorktreeService');
  const ptyManager = load('services/ptyManager');
  const { databaseService } = load('services/DatabaseService');
  const { createDrizzleClient } = load('db/drizzleClient');
  return { worktreeService, ptyManager, databaseService, createDrizzleClient };
}

module.exports = { getServices };
