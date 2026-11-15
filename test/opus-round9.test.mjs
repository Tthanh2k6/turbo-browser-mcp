// opus-round9: independent outer gatekeeper suite (opus-gatekeeper-8).
//
// Pure Node tests on resolveSafePath (no browser): fast, offline, deterministic.
// - "R9O-REG-*" re-verify R8O-BUG-01 (no filesystem/network I/O on rejected UNC/device/traversal paths) and the
//   existing link-escape / symlinked-root behaviour.
// - "R9O-BUG-01" is a fresh finding: a DANGLING link inside the save root whose target lies outside the root is
//   accepted, because canonicalizePath() probes with fs.existsSync(), which follows the link and reports "missing",
//   so the walk falls back to the lexical path. A later fs.writeFileSync()/storageState({path}) follows the link and
//   creates the target outside the root (POSIX file symlinks; Windows file symlinks with Developer Mode/admin).
//   Real links only: a directory junction on Windows (no privilege needed), a file symlink elsewhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { resolveSafePath } from '../src/dom-engine.mjs';

const IS_WIN = process.platform === 'win32';
const norm = (p) => (IS_WIN ? path.resolve(String(p)).toLowerCase() : path.resolve(String(p)));
const inside = (p, root) => {
  const rel = path.relative(norm(root), norm(p));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
};

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe('opus-round9: outer gatekeeper suite', { concurrency: 1 }, () => {
  let tmpDir;
  let root;
  let realRoot;
  let outside;
  let linkRoot;
  const links = [];

  const mkLink = (target, at, kindHint) => {
    fs.symlinkSync(target, at, IS_WIN ? 'junction' : kindHint);
    links.push(at);
    return at;
  };

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-opus-r9-'));
    root = path.join(tmpDir, 'root');
    outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(outside, 'existing'), { recursive: true });
    realRoot = fs.realpathSync(root);
    linkRoot = mkLink(root, path.join(tmpDir, 'link-root'), 'dir');
  });

  after(() => {
    for (const l of links.reverse()) {
      try {
        fs.unlinkSync(l);
      } catch {
        try {
          fs.rmdirSync(l);
        } catch {
          // already gone
        }
      }
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('R9O-REG R8O-BUG-01: rejected paths cause zero filesystem calls outside the root', () => {
    it('R9O-REG-01 UNC, device-namespace and traversal paths are rejected without any fs call on them', () => {
      const METHODS = ['existsSync', 'lstatSync', 'statSync', 'accessSync', 'readlinkSync', 'openSync', 'mkdirSync', 'writeFileSync', 'readFileSync', 'readdirSync'];
      const orig = Object.fromEntries(METHODS.map((m) => [m, fs[m]]));
      const origReal = fs.realpathSync;
      const origRealNative = fs.realpathSync.native;
      const foreign = [];
      const isNet = (p) => /^[\\/]{2}/.test(String(p));
      const record = (name, p) => {
        if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
        const s = String(p);
        if (isNet(s) || !inside(s, root)) {
          foreign.push(`${name}:${s}`);
          return true;
        }
        return false;
      };
      const enoent = (name, p) => Object.assign(new Error(`ENOENT (stubbed) ${name} ${p}`), { code: 'ENOENT' });
      for (const m of METHODS) {
        fs[m] = function (p, ...rest) {
          if (record(m, p) && isNet(p)) {
            if (m === 'existsSync') return false;
            throw enoent(m, p);
          }
          return orig[m].call(this, p, ...rest);
        };
      }
      const realStub = function (p, ...rest) {
        if (record('realpathSync', p) && isNet(p)) throw enoent('realpathSync', p);
        return origReal.call(this, p, ...rest);
      };
      realStub.native = function (p, ...rest) {
        if (record('realpathSync.native', p) && isNet(p)) throw enoent('realpathSync.native', p);
        return origRealNative.call(this, p, ...rest);
      };
      fs.realpathSync = realStub;

      const inputs = [
        '//tbm-r9-attacker.invalid/share/loot.json',
        path.join(root, '..', 'outside', 'escape.json'),
        path.join(root, 'a', '..', '..', 'outside', 'existing', 'escape.json'),
        path.join(outside, 'existing', 'escape.json'),
      ];
      if (IS_WIN) {
        inputs.push(
          '\\\\tbm-r9-attacker.invalid\\share\\loot.json',
          '\\\\tbm-r9-attacker.invalid@SSL@443\\DavWWWRoot\\loot.json',
          '\\\\.\\pipe\\tbm-r9-pipe',
          '\\\\?\\UNC\\tbm-r9-attacker.invalid\\share\\loot.json',
          '\\\\?\\GLOBALROOT\\Device\\Mup\\tbm-r9-attacker.invalid\\share\\x.json',
          '/\\tbm-r9-attacker.invalid/share/loot.json',
          '\\\\127.0.0.1\\c$\\Windows\\Temp\\tbm-r9.json'
        );
      }
      try {
        withEnv({ TURBO_BROWSER_SAVE_ROOT: root }, () => {
          for (const p of inputs) {
            assert.throws(() => resolveSafePath(p, 'saveStorageStatePath'), /outside allowed root|rejects/, p);
          }
        });
      } finally {
        for (const m of METHODS) fs[m] = orig[m];
        fs.realpathSync = origReal;
      }
      assert.equal(fs.realpathSync, origReal);
      assert.deepEqual(foreign, [], `containment check touched paths outside the root: ${JSON.stringify(foreign)}`);
    });
  });

  describe('R9O-REG link containment and symlinked roots', () => {
    it('R9O-REG-02 an existing link inside the root that points outside is rejected (link itself and paths through it)', () => {
      const esc = mkLink(path.join(outside, 'existing'), path.join(root, 'esc-existing'), 'dir');
      withEnv({ TURBO_BROWSER_SAVE_ROOT: root }, () => {
        assert.throws(() => resolveSafePath(path.join(esc, 'x.json')), /outside allowed root/);
        assert.throws(() => resolveSafePath(path.join(esc, 'deep', 'er', 'x.json')), /outside allowed root/);
        assert.throws(() => resolveSafePath(esc), /outside allowed root/);
      });
      assert.deepEqual(fs.readdirSync(path.join(outside, 'existing')), []);
    });

    it('R9O-REG-03 a symlinked TURBO_BROWSER_SAVE_ROOT accepts saves and returns the canonical path inside the real root', () => {
      withEnv({ TURBO_BROWSER_SAVE_ROOT: linkRoot }, () => {
        const viaLink = resolveSafePath(path.join(linkRoot, 'sub', 'a.json'));
        assert.equal(norm(viaLink), norm(path.join(realRoot, 'sub', 'a.json')));
        const viaReal = resolveSafePath(path.join(root, 'b.json'));
        assert.equal(norm(viaReal), norm(path.join(realRoot, 'b.json')));
        fs.mkdirSync(path.dirname(viaLink), { recursive: true });
        fs.writeFileSync(viaLink, '{}');
        assert.equal(fs.readFileSync(path.join(root, 'sub', 'a.json'), 'utf8'), '{}');
        assert.throws(() => resolveSafePath(path.join(linkRoot, '..', 'outside', 'x.json')), /outside allowed root/);
      });
    });

    it('R9O-REG-04 a symlinked cwd (no TURBO_BROWSER_SAVE_ROOT) accepts relative saves; traversal out of it is rejected', () => {
      const prevCwd = process.cwd();
      process.chdir(linkRoot);
      try {
        withEnv({ TURBO_BROWSER_SAVE_ROOT: undefined }, () => {
          const r = resolveSafePath(path.join('rel', 'c.json'));
          assert.ok(inside(r, realRoot), r);
          assert.equal(norm(r), norm(path.join(realRoot, 'rel', 'c.json')));
          assert.throws(() => resolveSafePath(path.join('..', 'outside', 'x.json')), /outside allowed root/);
        });
      } finally {
        process.chdir(prevCwd);
      }
    });

    it('R9O-REG-05 multiple roots via path.delimiter: each root accepted, sibling-prefix directory rejected', () => {
      const second = path.join(tmpDir, 'second');
      const sibling = path.join(tmpDir, 'rootX');
      fs.mkdirSync(second, { recursive: true });
      withEnv({ TURBO_BROWSER_SAVE_ROOT: `${root}${path.delimiter} ${second} ` }, () => {
        assert.ok(inside(resolveSafePath(path.join(second, 'x.json')), second));
        assert.ok(inside(resolveSafePath(path.join(root, 'y.json')), realRoot));
        assert.throws(() => resolveSafePath(path.join(sibling, 'z.json')), /outside allowed root/);
      });
    });
  });

  describe('R9O-BUG-01 dangling link inside the root whose target is outside the root', () => {
    // Today resolveSafePath returns <root>/<link> for these, because fs.existsSync(<link>) follows the dangling link and
    // reports false, so canonicalizePath walks up and re-appends the link name lexically. writeSaveFile /
    // storageState({path}) then write THROUGH the link, creating the file outside the root on POSIX (and on Windows
    // when file symlinks are permitted). Expected: reject (or resolve the link target and reject it as outside).
    it('R9O-BUG-01a a dangling link at the save path itself is rejected', () => {
      const target = path.join(outside, 'r9-dangling-target.json');
      const link = mkLink(target, path.join(root, 'dangling-file.json'), 'file');
      assert.equal(fs.existsSync(target), false);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      withEnv({ TURBO_BROWSER_SAVE_ROOT: root }, () => {
        let accepted = null;
        let threw = null;
        try {
          accepted = resolveSafePath(link, 'saveStorageStatePath');
        } catch (e) {
          threw = e;
        }
        assert.ok(threw instanceof Error, `dangling link to ${target} was accepted as ${accepted}`);
      });
      assert.equal(fs.existsSync(target), false);
    });

    it('R9O-BUG-01b a path below a dangling directory link is rejected', () => {
      const target = path.join(outside, 'r9-dangling-dir');
      const link = mkLink(target, path.join(root, 'dangling-dir'), 'dir');
      assert.equal(fs.existsSync(target), false);
      withEnv({ TURBO_BROWSER_SAVE_ROOT: root }, () => {
        let accepted = null;
        let threw = null;
        try {
          accepted = resolveSafePath(path.join(link, 'sub', 'x.json'), 'savePath');
        } catch (e) {
          threw = e;
        }
        assert.ok(threw instanceof Error, `path below dangling link to ${target} was accepted as ${accepted}`);
      });
      assert.equal(fs.existsSync(target), false);
    });
  });
});
