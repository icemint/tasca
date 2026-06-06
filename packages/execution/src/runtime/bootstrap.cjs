'use strict';
/**
 * Headless module-resolution bootstrap.
 *
 * Installs the same `@shared/*` and `@/*` path aliases the vendored entry.ts
 * registers, plus routes every `require('electron')` to the headless stub.
 * Require this FIRST, before requiring any compiled vendor module.
 *
 * The compiled vendor main process lives at <vendor>/dist/main. Resolve it from
 * EMDASH_DIST_MAIN when set (the build script / harness pass it explicitly),
 * otherwise fall back to the in-repo vendored submodule layout:
 *   packages/execution/src/runtime/bootstrap.cjs
 *   -> ../../vendor/emdash/dist/main
 */
const path = require('path');
const Module = require('module');

const DIST =
  process.env.EMDASH_DIST_MAIN ||
  path.join(__dirname, '..', '..', 'vendor', 'emdash', 'dist', 'main');
const sharedBase = path.join(DIST, 'shared');
const mainBase = path.join(DIST, 'main');
const electronStub = path.join(__dirname, 'electron-stub.cjs');

const orig = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (typeof request === 'string') {
    if (request === 'electron') {
      return orig.call(this, electronStub, parent, isMain, options);
    }
    if (request.startsWith('@shared/')) {
      return orig.call(
        this,
        path.join(sharedBase, request.slice('@shared/'.length)),
        parent,
        isMain,
        options
      );
    }
    if (request.startsWith('@/')) {
      return orig.call(
        this,
        path.join(mainBase, request.slice('@/'.length)),
        parent,
        isMain,
        options
      );
    }
  }
  return orig.call(this, request, parent, isMain, options);
};

module.exports = { DIST, mainBase, sharedBase };
