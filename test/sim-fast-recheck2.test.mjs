import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSafePath } from '../src/dom-engine.mjs';

describe('sim-fast-recheck2 — resolveSafePath #179 diff-scoped audit', () => {
  it('1. rejects UNC, extended-length, device, traversal, sibling-prefix, ADS, and drive-relative paths with ZERO fs probes on untrusted targets', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tbmcp-recheck2-'));
    const allowedRoot = path.join(tmpBase, 'workspace');
    const siblingRoot = path.join(tmpBase, 'workspace-other');
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(siblingRoot, { recursive: true });

    const origEnv = process.env.TURBO_BROWSER_SAVE_ROOT;
    const origExists = fs.existsSync;
    const origRealpath = fs.realpathSync;

    const probedPaths = [];
    const normalizedRoot = fs.realpathSync(allowedRoot).toLowerCase();
    const rawNormalizedRoot = path.resolve(allowedRoot).toLowerCase();

    try {
      process.env.TURBO_BROWSER_SAVE_ROOT = allowedRoot;

      fs.existsSync = function (p) {
        probedPaths.push({ fn: 'existsSync', path: String(p) });
        return origExists.call(this, p);
      };
      fs.realpathSync = function (p, ...rest) {
        probedPaths.push({ fn: 'realpathSync', path: String(p) });
        return origRealpath.call(this, p, ...rest);
      };

      const badInputs = [
        '//192.0.2.99/share/ntlm-leak.txt',
        '../outside.txt',
        'sub/../../../outside.txt',
        path.join(siblingRoot, 'secret.txt'),
        '../workspace-other/secret.txt',
      ];
      if (process.platform === 'win32') {
        badInputs.push(
          '\\\\192.0.2.99\\share\\ntlm-leak.txt',
          '\\\\server\\share\\sub\\file.png',
          '\\\\?\\UNC\\server\\share\\file.png',
          '\\\\.\\pipe\\secret-pipe',
          '\\\\?\\C:\\Windows\\System32\\drivers\\etc\\hosts',
          '\\\\.\\C:\\Windows\\win.ini',
          '..\\outside.txt',
          'sub\\..\\..\\..\\outside.txt',
          '..\\workspace-other\\secret.txt',
          path.join(allowedRoot, 'valid.txt:secret_ads'),
          'C:drive-relative.txt',
          path.join(allowedRoot, 'trailingdot.', 'file.txt'),
          path.join(allowedRoot, 'NUL.txt')
        );
      }

      for (const input of badInputs) {
        probedPaths.length = 0;
        assert.throws(
          () => resolveSafePath(input, 'auditTest'),
          /outside allowed root|rejects|invalid/i,
          `Expected resolveSafePath to reject: ${input}`
        );

        const untrustedProbes = probedPaths.filter(({ path: p }) => {
          const low = path.resolve(p).toLowerCase();
          return low !== normalizedRoot && low !== rawNormalizedRoot;
        });
        assert.equal(
          untrustedProbes.length,
          0,
          `Expected zero fs probes on untrusted input "${input}", but saw: ${JSON.stringify(untrustedProbes)}`
        );
      }
    } finally {
      fs.existsSync = origExists;
      fs.realpathSync = origRealpath;
      if (origEnv === undefined) delete process.env.TURBO_BROWSER_SAVE_ROOT;
      else process.env.TURBO_BROWSER_SAVE_ROOT = origEnv;
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('2. rejects junction/symlink inside allowed root pointing outside (both direct and nested non-existent subpath)', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tbmcp-recheck2-junc-'));
    const allowedRoot = path.join(tmpBase, 'root');
    const outsideDir = path.join(tmpBase, 'outside-secret');
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'existing.txt'), 'secret', 'utf8');

    const junctionPath = path.join(allowedRoot, 'escape-junc');
    fs.symlinkSync(outsideDir, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');

    const origEnv = process.env.TURBO_BROWSER_SAVE_ROOT;
    try {
      process.env.TURBO_BROWSER_SAVE_ROOT = allowedRoot;

      assert.throws(
        () => resolveSafePath(path.join(junctionPath, 'existing.txt')),
        /outside allowed root/i
      );

      assert.throws(
        () => resolveSafePath(path.join(junctionPath, 'deep', 'nonexistent', 'newfile.json')),
        /outside allowed root/i
      );
    } finally {
      if (origEnv === undefined) delete process.env.TURBO_BROWSER_SAVE_ROOT;
      else process.env.TURBO_BROWSER_SAVE_ROOT = origEnv;
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('3. allows valid relative, nested, existing, and non-existing paths inside symlinked cwd and custom TURBO_BROWSER_SAVE_ROOT', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tbmcp-recheck2-ok-'));
    const realWorkspace = path.join(tmpBase, 'real-workspace');
    const symlinkedCwd = path.join(tmpBase, 'linked-cwd');
    const secondaryRoot = path.join(tmpBase, 'secondary-root');
    fs.mkdirSync(path.join(realWorkspace, 'existing-dir'), { recursive: true });
    fs.writeFileSync(path.join(realWorkspace, 'existing-dir', 'hello.txt'), 'ok', 'utf8');
    fs.mkdirSync(secondaryRoot, { recursive: true });
    fs.symlinkSync(realWorkspace, symlinkedCwd, process.platform === 'win32' ? 'junction' : 'dir');

    const origCwd = process.cwd();
    const origEnv = process.env.TURBO_BROWSER_SAVE_ROOT;
    try {
      delete process.env.TURBO_BROWSER_SAVE_ROOT;
      process.chdir(symlinkedCwd);

      const canonWorkspace = fs.realpathSync(realWorkspace);

      // Existing relative path inside junctioned cwd
      const res1 = resolveSafePath('existing-dir/hello.txt');
      assert.equal(res1.toLowerCase(), path.join(canonWorkspace, 'existing-dir', 'hello.txt').toLowerCase());

      // Non-existing nested relative path inside junctioned cwd
      const res2 = resolveSafePath('new-folder/sub/output.png');
      assert.equal(res2.toLowerCase(), path.join(canonWorkspace, 'new-folder', 'sub', 'output.png').toLowerCase());

      // Explicit path via symlinked cwd prefix (un-canonicalized lexical prefix matching rawRoot)
      const res3 = resolveSafePath(path.join(symlinkedCwd, 'deep', 'state.json'));
      assert.equal(res3.toLowerCase(), path.join(canonWorkspace, 'deep', 'state.json').toLowerCase());

      // Custom TURBO_BROWSER_SAVE_ROOT with multiple roots
      process.env.TURBO_BROWSER_SAVE_ROOT = `${symlinkedCwd}${path.delimiter}${secondaryRoot}`;
      const canonSecondary = fs.realpathSync(secondaryRoot);
      const res4 = resolveSafePath(path.join(secondaryRoot, 'nested', 'artifact.txt'));
      assert.equal(res4.toLowerCase(), path.join(canonSecondary, 'nested', 'artifact.txt').toLowerCase());
    } finally {
      process.chdir(origCwd);
      if (origEnv === undefined) delete process.env.TURBO_BROWSER_SAVE_ROOT;
      else process.env.TURBO_BROWSER_SAVE_ROOT = origEnv;
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
