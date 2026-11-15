import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveSafePath } from '../src/dom-engine.mjs';

describe('sim-fast-recheck3: canonicalizePath & resolveSafePath hardening', () => {
  const tempDirs = [];
  const origSaveRoot = process.env.TURBO_BROWSER_SAVE_ROOT;

  function makeTempDir(prefix = 'tb-recheck3-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  after(() => {
    if (origSaveRoot === undefined) {
      delete process.env.TURBO_BROWSER_SAVE_ROOT;
    } else {
      process.env.TURBO_BROWSER_SAVE_ROOT = origSaveRoot;
    }
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  test('1. In-root symlink pointing to UNC path (\\\\attacker\\share\\missing and \\\\?\\UNC\\attacker\\share\\x) throws with 0 realpathSync calls on UNC target', () => {
    const rootDir = makeTempDir('tb-unc-root-');
    process.env.TURBO_BROWSER_SAVE_ROOT = rootDir;

    const fakeLink1 = path.join(rootDir, 'unc-link-1');
    const fakeLink2 = path.join(rootDir, 'unc-link-2');

    const origLstatSync = fs.lstatSync;
    const origReadlinkSync = fs.readlinkSync;
    const origRealpathSync = fs.realpathSync;

    let realpathCallsOnLink = 0;

    fs.lstatSync = function (p, options) {
      const resolvedP = path.resolve(String(p));
      if (resolvedP === fakeLink1 || resolvedP === fakeLink2) {
        return { isSymbolicLink: () => true };
      }
      return origLstatSync.call(this, p, options);
    };

    fs.readlinkSync = function (p, options) {
      const resolvedP = path.resolve(String(p));
      if (resolvedP === fakeLink1) {
        return '\\\\attacker\\share\\missing';
      }
      if (resolvedP === fakeLink2) {
        return '\\\\?\\UNC\\attacker\\share\\x';
      }
      return origReadlinkSync.call(this, p, options);
    };

    fs.realpathSync = function (p, options) {
      const resolvedP = path.resolve(String(p));
      if (
        resolvedP === fakeLink1 ||
        resolvedP === fakeLink2 ||
        String(p).includes('attacker')
      ) {
        realpathCallsOnLink++;
      }
      return origRealpathSync.call(this, p, options);
    };

    try {
      assert.throws(
        () => resolveSafePath(path.join(fakeLink1, 'payload.json')),
        /Refusing symlink\/junction .* targeting network\/UNC path/i
      );
      assert.throws(
        () => resolveSafePath(path.join(fakeLink2, 'payload.json')),
        /Refusing symlink\/junction .* targeting network\/UNC path/i
      );
      assert.equal(realpathCallsOnLink, 0, 'Must not invoke fs.realpathSync on UNC symlink target');
    } finally {
      fs.lstatSync = origLstatSync;
      fs.readlinkSync = origReadlinkSync;
      fs.realpathSync = origRealpathSync;
    }
  });

  test('2. ELOOP from lstatSync throws immediately when resolving candidate path (rejectDangling: true)', () => {
    const rootDir = makeTempDir('tb-eloop-root-');
    process.env.TURBO_BROWSER_SAVE_ROOT = rootDir;

    const loopPath = path.join(rootDir, 'cyclic-link');
    const origLstatSync = fs.lstatSync;

    fs.lstatSync = function (p, options) {
      if (path.resolve(String(p)) === loopPath) {
        const err = new Error('ELOOP: too many symbolic links encountered');
        err.code = 'ELOOP';
        throw err;
      }
      return origLstatSync.call(this, p, options);
    };

    try {
      assert.throws(
        () => resolveSafePath(path.join(loopPath, 'out.json')),
        /Refusing cyclic symlink\/junction .* \(outside allowed root\)/i
      );
    } finally {
      fs.lstatSync = origLstatSync;
    }
  });

  test('3. TURBO_BROWSER_SAVE_ROOT containing a broken symlink entry alongside a valid directory succeeds cleanly for valid root saves', () => {
    const validRoot = makeTempDir('tb-valid-root-');
    const holderRoot = makeTempDir('tb-holder-root-');
    const brokenRootEntry = path.join(holderRoot, 'broken-root-symlink');

    const origLstatSync = fs.lstatSync;
    const origReadlinkSync = fs.readlinkSync;
    const origRealpathSync = fs.realpathSync;

    // Simulate broken symlink for brokenRootEntry even if OS symlink privileges vary
    fs.lstatSync = function (p, options) {
      if (path.resolve(String(p)) === brokenRootEntry) {
        return { isSymbolicLink: () => true };
      }
      return origLstatSync.call(this, p, options);
    };
    fs.readlinkSync = function (p, options) {
      if (path.resolve(String(p)) === brokenRootEntry) {
        return path.join(holderRoot, 'nonexistent-target');
      }
      return origReadlinkSync.call(this, p, options);
    };
    fs.realpathSync = function (p, options) {
      if (path.resolve(String(p)) === brokenRootEntry) {
        const err = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
      }
      return origRealpathSync.call(this, p, options);
    };

    try {
      process.env.TURBO_BROWSER_SAVE_ROOT = `${brokenRootEntry}${path.delimiter}${validRoot}`;
      const targetFile = path.join(validRoot, 'nested', 'state.json');
      const resolved = resolveSafePath(targetFile);
      assert.ok(
        resolved.endsWith(path.join('nested', 'state.json')),
        `Expected resolved path inside validRoot, got: ${resolved}`
      );
    } finally {
      fs.lstatSync = origLstatSync;
      fs.readlinkSync = origReadlinkSync;
      fs.realpathSync = origRealpathSync;
    }
  });
});
