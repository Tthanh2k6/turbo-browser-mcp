// Round 10 outer-gatekeeper tests (opus-gatekeeper-9).
// Pins R9O-BUG-01a/b fixes in canonicalizePath/resolveSafePath (src/dom-engine.mjs:68-193)
// using REAL NTFS junctions where possible (no symlink privilege needed) and fs mocks only
// for things that cannot be created unprivileged (UNC symlinks, ELOOP).
import { test, describe, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveSafePath, capturePage } from '../src/dom-engine.mjs';

const isWin = process.platform === 'win32';
const linkType = isWin ? 'junction' : 'dir';

describe('opus-round10: path hardening (R9O-BUG-01a/b) + adversarial probes', { concurrency: 1 }, () => {
  const tempDirs = [];
  const origSaveRoot = process.env.TURBO_BROWSER_SAVE_ROOT;
  const origFs = {
    lstatSync: fs.lstatSync,
    readlinkSync: fs.readlinkSync,
    realpathSync: fs.realpathSync,
  };
  let base;
  let root;
  let outside;

  const mk = (p) => {
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  const link = (target, p) => fs.symlinkSync(target, p, linkType);

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-opus-r10-')));
    tempDirs.push(base);
    root = mk(path.join(base, 'root'));
    outside = mk(path.join(base, 'outside'));
    process.env.TURBO_BROWSER_SAVE_ROOT = root;
  });

  afterEach(() => {
    fs.lstatSync = origFs.lstatSync;
    fs.readlinkSync = origFs.readlinkSync;
    fs.realpathSync = origFs.realpathSync;
  });

  after(() => {
    fs.lstatSync = origFs.lstatSync;
    fs.readlinkSync = origFs.readlinkSync;
    fs.realpathSync = origFs.realpathSync;
    if (origSaveRoot === undefined) delete process.env.TURBO_BROWSER_SAVE_ROOT;
    else process.env.TURBO_BROWSER_SAVE_ROOT = origSaveRoot;
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  test('R10-01 real dangling junction inside root: leaf, <link>/x.json and <link>/sub/x.json all throw; target never created', () => {
    const target = path.join(base, 'ghost-target');
    const jn = path.join(root, 'jn');
    link(target, jn);
    for (const p of [jn, path.join(jn, 'x.json'), path.join(jn, 'sub', 'deeper', 'x.json')]) {
      assert.throws(() => resolveSafePath(p), /Refusing dangling or unresolvable symlink\/junction/);
    }
    assert.equal(fs.existsSync(target), false);
  });

  test('R10-02 dangling junction several real dirs deep (root/a/b/jn/c/d.json) throws', () => {
    const ab = mk(path.join(root, 'a', 'b'));
    link(path.join(base, 'nowhere'), path.join(ab, 'jn'));
    assert.throws(
      () => resolveSafePath(path.join(ab, 'jn', 'c', 'd.json')),
      /Refusing dangling or unresolvable symlink\/junction ".*jn"/
    );
  });

  test('R10-03 junction chain jn1 -> jn2 -> (missing) throws; jn1 -> jn2 -> outside rejected; jn1 -> jn2 -> inside allowed canonically', () => {
    const jn2dead = path.join(base, 'jn2dead');
    link(path.join(base, 'missing'), jn2dead);
    link(jn2dead, path.join(root, 'chainDead'));
    assert.throws(() => resolveSafePath(path.join(root, 'chainDead', 'x.json')), /Refusing dangling/);

    const jn2out = path.join(base, 'jn2out');
    link(outside, jn2out);
    link(jn2out, path.join(root, 'chainOut'));
    assert.throws(() => resolveSafePath(path.join(root, 'chainOut', 'n', 'x.json')), /resolves outside allowed root/);

    const inDir = mk(path.join(root, 'inner'));
    const jn2in = path.join(base, 'jn2in');
    link(inDir, jn2in);
    link(jn2in, path.join(root, 'chainIn'));
    assert.equal(
      resolveSafePath(path.join(root, 'chainIn', 'n', 'x.json')),
      path.join(inDir, 'n', 'x.json')
    );
  });

  test('R10-04 real cyclic junctions (ca <-> cb) throw for leaf and child paths', () => {
    const ca = path.join(root, 'ca');
    const cb = path.join(root, 'cb');
    link(cb, ca);
    link(ca, cb);
    assert.throws(() => resolveSafePath(ca), /Refusing (dangling|cyclic)/);
    assert.throws(() => resolveSafePath(path.join(ca, 'x.json')), /Refusing (dangling|cyclic)/);
    assert.throws(() => resolveSafePath(path.join(cb, 'y', 'x.json')), /Refusing (dangling|cyclic)/);
  });

  test('R10-05 ELOOP from lstat on a candidate ancestor throws "cyclic"; ELOOP on a SAVE_ROOT entry is tolerated for sibling roots', () => {
    const loop = path.join(root, 'loop');
    const loopRoot = path.join(base, 'loop-root');
    const validRoot = mk(path.join(base, 'valid'));
    fs.lstatSync = function (p, o) {
      const r = path.resolve(String(p));
      if (r === loop || r.startsWith(loop + path.sep) || r === loopRoot || r.startsWith(loopRoot + path.sep)) {
        const e = new Error('ELOOP: too many symbolic links encountered');
        e.code = 'ELOOP';
        throw e;
      }
      return origFs.lstatSync.call(this, p, o);
    };
    assert.throws(() => resolveSafePath(path.join(loop, 'a', 'x.json')), /Refusing cyclic symlink\/junction ".*loop/);
    process.env.TURBO_BROWSER_SAVE_ROOT = [loopRoot, validRoot].join(path.delimiter);
    assert.equal(resolveSafePath(path.join(validRoot, 's', 'x.json')), path.join(validRoot, 's', 'x.json'));
  });

  test('R10-06 UNC symlink targets (5 spellings) at the deepest existing component are refused with 0 realpathSync calls through the link', () => {
    const targets = [
      '\\\\attacker\\share',
      '//attacker/share',
      '\\\\?\\UNC\\attacker\\share\\x',
      '\\\\.\\UNC\\attacker\\share\\x',
      '\\??\\UNC\\attacker\\share\\x',
    ];
    const links = new Map(targets.map((t, i) => [path.join(root, `unc${i}`), t]));
    let realpathThroughLink = 0;
    fs.lstatSync = function (p, o) {
      const r = path.resolve(String(p));
      for (const l of links.keys()) {
        if (r === l) return { isSymbolicLink: () => true };
        if (r.startsWith(l + path.sep)) return undefined; // child missing on share
      }
      return origFs.lstatSync.call(this, p, o);
    };
    fs.readlinkSync = function (p, o) {
      const r = path.resolve(String(p));
      if (links.has(r)) return links.get(r);
      return origFs.readlinkSync.call(this, p, o);
    };
    fs.realpathSync = function (p, o) {
      const r = path.resolve(String(p));
      for (const l of links.keys()) if (r === l || r.startsWith(l + path.sep)) realpathThroughLink++;
      if (/attacker/i.test(String(p))) realpathThroughLink++;
      return origFs.realpathSync.call(this, p, o);
    };
    for (const l of links.keys()) {
      assert.throws(() => resolveSafePath(l), /targeting network\/UNC path/);
      assert.throws(() => resolveSafePath(path.join(l, 'payload.json')), /targeting network\/UNC path/);
      assert.throws(() => resolveSafePath(path.join(l, 'a', 'b', 'payload.json')), /targeting network\/UNC path/);
    }
    assert.equal(realpathThroughLink, 0);
  });

  test('R10-07 UNC link whose child EXISTS on the share is still rejected (outcome pinned, regardless of OS traversal)', () => {
    const l = path.join(root, 'uncExisting');
    const shareFile = '\\\\attacker\\share\\exists.json';
    fs.lstatSync = function (p, o) {
      const r = path.resolve(String(p));
      if (r === l) return { isSymbolicLink: () => true };
      if (r === path.join(l, 'exists.json')) return { isSymbolicLink: () => false };
      return origFs.lstatSync.call(this, p, o);
    };
    fs.readlinkSync = function (p, o) {
      if (path.resolve(String(p)) === l) return '\\\\attacker\\share';
      return origFs.readlinkSync.call(this, p, o);
    };
    fs.realpathSync = function (p, o) {
      const r = path.resolve(String(p));
      if (r === path.join(l, 'exists.json')) return shareFile;
      if (r === l) return '\\\\attacker\\share';
      return origFs.realpathSync.call(this, p, o);
    };
    assert.throws(
      () => resolveSafePath(path.join(l, 'exists.json'), 'loadStorageStatePath'),
      /(targeting network\/UNC path|resolves outside allowed root)/
    );
  });

  test('R10-08 non-UNC relative dangling symlink target (..\\..\\outside\\new) throws dangling, not lexical fallback', () => {
    const l = path.join(root, 'rel');
    fs.lstatSync = function (p, o) {
      const r = path.resolve(String(p));
      if (r === l) return { isSymbolicLink: () => true };
      if (r.startsWith(l + path.sep)) return undefined;
      return origFs.lstatSync.call(this, p, o);
    };
    fs.readlinkSync = function (p, o) {
      if (path.resolve(String(p)) === l) return `..${path.sep}..${path.sep}outside${path.sep}new`;
      return origFs.readlinkSync.call(this, p, o);
    };
    fs.realpathSync = function (p, o) {
      const r = path.resolve(String(p));
      if (r === l || r.startsWith(l + path.sep)) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return origFs.realpathSync.call(this, p, o);
    };
    assert.throws(() => resolveSafePath(path.join(l, 'x.json')), /Refusing dangling or unresolvable/);
  });

  test('R10-09 junctioned SAVE_ROOT + broken sibling root entry: link and real spellings both save; writes under the broken root are refused', () => {
    const real2 = mk(path.join(base, 'real2'));
    const link2 = path.join(base, 'link2');
    link(real2, link2);
    const broken = path.join(base, 'brokenRoot');
    link(path.join(base, 'gone'), broken);
    process.env.TURBO_BROWSER_SAVE_ROOT = [broken, link2].join(path.delimiter);
    const want = path.join(real2, 'a', 'b.json');
    assert.equal(resolveSafePath(path.join(link2, 'a', 'b.json')), want);
    assert.equal(resolveSafePath(path.join(real2, 'a', 'b.json')), want);
    assert.throws(() => resolveSafePath(path.join(broken, 'x.json')), /Refusing dangling/);
    assert.throws(() => resolveSafePath(path.join(outside, 'x.json')), /resolves outside allowed root/);
    assert.equal(fs.existsSync(path.join(base, 'gone')), false);
  });

  test('R10-10 junction inside root pointing outside: new and EXISTING outside files are rejected (load + save)', () => {
    fs.writeFileSync(path.join(outside, 'secret.json'), '{"cookies":[]}');
    link(outside, path.join(root, 'jout'));
    assert.throws(() => resolveSafePath(path.join(root, 'jout', 'new', 'x.json')), /resolves outside allowed root/);
    assert.throws(
      () => resolveSafePath(path.join(root, 'jout', 'secret.json'), 'loadStorageStatePath'),
      /resolves outside allowed root/
    );
    // lexical ".." through the junction never escapes either
    assert.throws(() => resolveSafePath(path.join(root, 'jout', '..', '..', 'outside', 'x.json')), /resolves outside allowed root/);
  });

  test('R10-11 Windows case-insensitive root match + NTFS edge spellings', () => {
    const p = path.join(root, 'Case', 'x.json');
    if (isWin) {
      assert.equal(resolveSafePath(p.toUpperCase()).toLowerCase(), p.toLowerCase());
      assert.throws(() => resolveSafePath(path.join(root, 'x.json:stream')), /alternate data stream/);
      assert.throws(() => resolveSafePath(path.join(root, 'dir.', 'x.json')), /trailing dot or space/);
      assert.throws(() => resolveSafePath(path.join(root, 'NUL.txt')), /reserved device name/);
      assert.throws(() => resolveSafePath('C:relative.json'), /drive-relative/);
    } else {
      assert.equal(resolveSafePath(p), p);
    }
    assert.throws(() => resolveSafePath(`${root}${path.sep}a\0b`), /null byte/);
    assert.throws(() => resolveSafePath('   '), /non-empty/);
  });

  test('R10-12 UNC candidate path is rejected lexically with zero fs calls', () => {
    let attackerCalls = 0;
    for (const fn of ['lstatSync', 'realpathSync', 'readlinkSync']) {
      fs[fn] = function (p, ...rest) {
        if (/attacker/i.test(String(p))) attackerCalls++;
        return origFs[fn].call(this, p, ...rest);
      };
    }
    for (const bad of [
      '\\\\attacker\\share\\x.json',
      '//attacker/share/x.json',
      '\\\\?\\UNC\\attacker\\share\\x.json',
      `${root}${path.sep}..${path.sep}..${path.sep}..${path.sep}attacker${path.sep}x.json`,
    ]) {
      assert.throws(() => resolveSafePath(bad), /resolves outside allowed root|rejects/);
    }
    assert.equal(attackerCalls, 0);
  });

  test('R10-13 capturePage end-to-end: dangling junction savePath throws before any mkdir; inside junction writes to canonical path', async () => {
    const ghost = path.join(base, 'ghost-capture');
    link(ghost, path.join(root, 'capJn'));
    let shots = 0;
    const fakePage = {
      screenshot: async () => {
        shots++;
        return Buffer.from('png-bytes');
      },
    };
    await assert.rejects(
      capturePage(fakePage, { savePath: path.join(root, 'capJn', 'deep', 'shot.png') }),
      /Refusing dangling/
    );
    assert.equal(fs.existsSync(ghost), false, 'mkdir -p must not materialize the junction target');
    assert.equal(shots, 0);

    const inDir = mk(path.join(root, 'shots'));
    link(inDir, path.join(root, 'capIn'));
    const res = await capturePage(fakePage, { savePath: path.join(root, 'capIn', 'n', 'shot.png') });
    assert.equal(res.savePath, path.join(inDir, 'n', 'shot.png'));
    assert.equal(fs.readFileSync(res.savePath, 'utf8'), 'png-bytes');
    assert.equal(res.base64, undefined);
  });
});
