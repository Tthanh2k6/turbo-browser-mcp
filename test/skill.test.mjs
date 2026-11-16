// The bundled skill must match the installed version and the real tool schemas.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SKILL_PATH, TOOL_DEFINITIONS } from '../src/index.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const skill = fs.readFileSync(SKILL_PATH, 'utf8');
const tools = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t]));

// Every property name and enum string anywhere in the tool schemas.
const known = new Set(tools.keys());
(function collect(node) {
  if (Array.isArray(node)) return node.forEach(collect);
  if (!node || typeof node !== 'object') return;
  if (node.properties) for (const k of Object.keys(node.properties)) known.add(k);
  if (Array.isArray(node.enum)) for (const v of node.enum) if (typeof v === 'string') known.add(v);
  Object.values(node).forEach(collect);
})(TOOL_DEFINITIONS.map((t) => t.inputSchema));
// Batch step shapes and result fields are documented in prose in the schema, not as properties.
const STEP_ACTIONS = new Set([...tools.get('act_fast').inputSchema.properties.action.enum, 'smart_fill_form', 'navigate', 'extract', 'collect']);
const STEP_KEYS = new Set([
  ...Object.keys(tools.get('act_fast').inputSchema.properties),
  'url', 'format', 'scrolls', 'waitMs', 'maxItems', 'fields', 'textSelector', 'itemSelector',
]);
for (const x of [...STEP_ACTIONS, ...STEP_KEYS, 'submitVerified', 'true', 'false']) known.add(x);

describe('bundled skill', () => {
  it('--print-skill prints exactly the file', () => {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../src/index.mjs', import.meta.url)), '--print-skill'], { encoding: 'utf8', cwd: ROOT });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, skill);
  });

  it('has Agent Skills frontmatter, stays under 600 words, no em dashes', () => {
    const m = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/.exec(skill.replace(/\r\n/g, '\n'));
    assert.ok(m, 'frontmatter with name and description');
    assert.equal(m[1], 'turbo-browser');
    assert.ok(m[2].length > 40 && m[2].length < 1024);
    const words = skill.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length;
    assert.ok(words < 600, `${words} words`);
    assert.ok(!/—|–/.test(skill), 'no em or en dashes');
  });

  it('is listed in package.json files and ships with the package', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.ok(pkg.files.includes('skills/'));
    assert.ok(fs.existsSync(SKILL_PATH));
  });

  it('every backticked identifier names a real tool, parameter, enum value or step key', () => {
    const prose = skill.replace(/```[\s\S]*?```/g, ' ');
    const ids = [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
    assert.ok(ids.length > 20);
    const missing = [...new Set(ids)].filter((id) => !known.has(id) && !['text', 'ref'].includes(id));
    assert.deepEqual(missing, []);
  });

  it('every example call uses a real tool with parameters from its schema', () => {
    const calls = [];
    for (const block of skill.matchAll(/```\n([\s\S]*?)```/g)) {
      for (const line of block[1].split('\n').filter((l) => l.trim())) {
        const m = /^([a-z_]+) (\{.*\})$/.exec(line);
        assert.ok(m, `example line is "tool {json}": ${line}`);
        calls.push({ tool: m[1], args: JSON.parse(m[2]) });
      }
    }
    assert.ok(calls.length >= 10);
    const used = new Set();
    for (const { tool, args } of calls) {
      const def = tools.get(tool);
      assert.ok(def, `unknown tool ${tool}`);
      used.add(tool);
      const props = def.inputSchema.properties;
      for (const k of Object.keys(args)) assert.ok(k in props, `${tool}: unknown parameter ${k}`);
      if (args.mode) assert.ok(props.mode.enum.includes(args.mode), `${tool}: mode ${args.mode}`);
      if (args.snapshotMode) assert.ok(props.snapshotMode.enum.includes(args.snapshotMode));
      if (tool === 'act_fast') assert.ok(props.action.enum.includes(args.action));
      for (const step of args.steps || []) {
        assert.ok(STEP_ACTIONS.has(step.action), `step action ${step.action}`);
        for (const k of Object.keys(step)) assert.ok(STEP_KEYS.has(k), `step key ${k}`);
      }
      if (args.expect) {
        const ep = props.expect.properties;
        for (const k of Object.keys(args.expect)) assert.ok(k in ep, `expect.${k}`);
      }
      for (const f of args.fields || []) {
        const fp = props.fields.items.properties;
        for (const k of Object.keys(f)) assert.ok(k in fp, `field key ${k}`);
      }
      for (const op of args.operations || []) {
        const op0 = props.operations.items.properties;
        assert.ok(op0.action.enum.includes(op.action), `tabs_batch action ${op.action}`);
        for (const k of Object.keys(op)) assert.ok(k in op0, `operation key ${k}`);
      }
    }
    for (const t of ['inspect_compact', 'smart_fill_form', 'batch_actions', 'act_fast', 'tabs_batch', 'wait_for_human']) {
      assert.ok(used.has(t), `${t} has an example`);
    }
  });
});
