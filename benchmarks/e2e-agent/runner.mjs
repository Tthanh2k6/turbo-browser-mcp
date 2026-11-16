import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { startServer, writeAttachment, attachmentPath } from './server.mjs';
import { evaluateRemote } from './evaluate.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(dir, '../..');
const root = 'D:\\dev\\bench-tmp';
const options = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2], process.argv[3 + i * 2]]));
const host = options['--claude'] ? 'claude' : 'codex';
if (!(options['--codex'] || options['--claude']) || !options['--model']) throw new Error('--codex or --claude, and --model, are required');
const resultsDir = path.join(dir, options['--results'] || 'results');
fs.mkdirSync(resultsDir, { recursive: true });
if (fs.existsSync(path.join(resultsDir, 'results.jsonl'))) throw new Error('Archive results/ before another run; refusing to mix trials or overwrite transcripts');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const authRoot = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const agentBrowser = path.join(root, 'npm/node_modules/.bin/agent-browser.cmd');
const browse = path.join(root, 'npm/node_modules/.bin/browse.cmd');
const browserUse = path.join(root, 'venv/Scripts/browser-use.exe');
let active;
function kill(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGKILL');
}
function execute(command, args, { cwd, env, input = '', timeout = 360000, log } = {}) {
  return new Promise(resolve => {
    const start = performance.now();
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    active = child;
    let stdout = '', stderr = '', timedOut = false, usageLimit = false;
    const onData = (chunk, isError) => {
      const text = chunk.toString();
      if (isError) stderr += text; else stdout += text;
      if (log) fs.appendFileSync(log + (isError ? '.stderr' : ''), text);
      if (/usage limit|usage_limit_reached|you(?:'|’)ve hit your usage limit/i.test(stdout + stderr)) { usageLimit = true; kill(child); }
    };
    child.stdout.on('data', b => onData(b, false)); child.stderr.on('data', b => onData(b, true));
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => { timedOut = true; kill(child); }, timeout);
    let done = false;
    const finish = (code, error) => {
      if (done) return; done = true; clearTimeout(timer); if (active === child) active = null;
      resolve({ code, error: error?.message, stdout, stderr, timedOut, usageLimit, elapsedMs: performance.now() - start });
    };
    child.on('error', e => finish(null, e)); child.on('close', code => finish(code));
    child.stdin.end(input);
  });
}
const { server, base } = await startServer();
writeAttachment();
process.on('SIGINT', () => { kill(active); server.close(); process.exit(130); });
process.on('SIGTERM', () => { kill(active); server.close(); process.exit(143); });
const taskPrompts = {
  application: `Open ${base}/application. Enter name Alex Nguyen and email alex@example.test. Select Region 150 from the portaled, searchable 200-option list. Upload {attachment}. Continue to review, submit once, and report the receipt number.`,
  catalog: `Open ${base}/catalog. Search for adapter, keep only in-stock items, visit every result page, and return a JSON array with id, name, and price sorted by id.`,
  booking: `Open ${base}/booking. Choose a remote appointment on 2030-06-18 at 10:00, enter Alex Nguyen and alex@example.test, continue through the draft step, review, confirm once, and report the booking reference.`,
};
const sharedAttachment = path.join(root, 'fixtures/attachment.pdf');
fs.mkdirSync(path.dirname(sharedAttachment), { recursive: true }); fs.copyFileSync(attachmentPath, sharedAttachment);
const nodeVersion = process.version;
const codexVersion = spawnSync(options['--codex'] || options['--claude'], ['--version'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() || null;
const versions = {};
for (const [stack, packagePath] of [['turbo', path.join(repo, 'package.json')], ['agent-browser', path.join(root, 'npm/node_modules/agent-browser/package.json')], ['browse', path.join(root, 'npm/node_modules/@opencode/browse/package.json')]]) {
  try { versions[stack] = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version; } catch { versions[stack] = null; }
}
try { versions['browser-harness'] = fs.readFileSync(path.join(root, 'python-freeze.txt'), 'utf8').replace(/^\uFEFF/, '').match(/^browser-use==(.+)$/mi)?.[1]?.trim() || null; } catch {}
async function hook(phase, stack, workspace, env) {
  if (!options['--hook']) throw new Error('Fresh browser setup hook required for browse and browser-harness (see README)');
  const result = await execute('powershell.exe', ['-NoProfile', '-File', path.resolve(options['--hook']), '-Phase', phase, '-Stack', stack, '-Workspace', workspace, '-Base', base], { cwd: workspace, env, timeout: 120000 });
  fs.appendFileSync(path.join(workspace, 'setup.log'), result.stdout + result.stderr);
  if (result.code !== 0 || result.timedOut) throw new Error(`${phase} hook failed: ${result.error || result.stderr || result.code}`);
  if (phase === 'cleanup') return;
  const data = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  if (!data.ready || !data.freshProfile || !data.browserVersion) throw new Error('Setup hook must attest ready, freshProfile and browserVersion');
  return data;
}
try {
  outer: for (const stack of (process.env.BENCH_STACKS ? process.env.BENCH_STACKS.split(',') : ['turbo', 'agent-browser', 'browse', 'browser-harness'])) {
    for (const task of Object.keys(taskPrompts)) { if (process.env.BENCH_ONLY && !process.env.BENCH_ONLY.split(",").includes(`${stack}:${task}`)) continue;
      console.log(`${stack} / ${task}`);
      const workspace = path.join(root, 'trials', runId, `${stack}_${task}`);
      fs.mkdirSync(workspace, { recursive: true });
      const homeDir = path.join(workspace, 'codex'); fs.mkdirSync(homeDir);
      // Copy credentials only. Do not inherit user MCP servers, skills, plugins or config.
      const authFile = path.join(authRoot, 'auth.json');
      if (fs.existsSync(authFile)) fs.copyFileSync(authFile, path.join(homeDir, 'auth.json'));
      fs.writeFileSync(path.join(homeDir, 'config.toml'), '');
      const env = { ...process.env, CODEX_HOME: homeDir, AGENT_BROWSER_SESSION: `${runId}-${task}`, BU_NAME: `${runId}-${task}`, TURBO_BROWSER_LEDGER: path.join(workspace, 'submissions.jsonl'), TURBO_BROWSER_SAVE_ROOT: workspace, OPENCODE_BROWSER_AUTO_UPDATE: 'off', OPENCODE_BROWSER_FILE_ROOTS: path.dirname(sharedAttachment) };
      // browse keeps its extension pairing token under the user's XDG dirs, so only TEMP/TMP are isolated for it.
      for (const key of (stack === 'browse' ? ['TEMP','TMP'] : ['XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','TEMP','TMP'])) { env[key] = path.join(workspace, key); fs.mkdirSync(env[key], { recursive: true }); }
      if (options['--chromium']) env.AGENT_BROWSER_EXECUTABLE_PATH = options['--chromium'];
      const prefix = path.join(resultsDir, `${stack}_${task}`), log = prefix + '.log';
      fs.writeFileSync(log, ''); fs.writeFileSync(log + '.stderr', '');
      let execution, evaluation, setup, failure = null, claudeJson = null;
      const setupStart = performance.now();
      let setupMs;
      try {
        const reset = await fetch(`${base}/__eval/reset`, { method: 'POST' }); if (!reset.ok) throw new Error('Reset failed');
        if (stack === 'browse' || stack === 'browser-harness') {
          setup = await hook('setup', stack, workspace, env);
          Object.assign(env, setup.env || {});
        }
        setupMs = performance.now() - setupStart;
        const instruction = fs.readFileSync(path.join(dir, 'stacks', stack + '.md'), 'utf8').replaceAll('{{agentBrowser}}', agentBrowser);
        const prompt = `${instruction}\n\nUse only the selected browser stack. You may read its installed documentation and the supplied attachment. Do not read fixture source, evaluator state, other trials, or repository files. Do not call HTTP endpoints directly, including from page JavaScript. Extract task data through the rendered UI. Do not install software or change configuration. Preserve any generated helper in this workspace.\n\n${taskPrompts[task].replace('{attachment}', sharedAttachment)}\n\nreport the final answer on the last line`;
        fs.writeFileSync(prefix + '.prompt.txt', prompt);
        const args = ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-c', 'web_search="disabled"', '-m', options['--model'], '-c', `model_reasoning_effort="${options['--reasoning'] || 'medium'}"`, '-o', path.join(workspace, 'answer.txt')];
        if (stack === 'turbo') args.push('-c', 'mcp_servers.turbo.command="node"', '-c', `mcp_servers.turbo.args=${JSON.stringify([path.join(repo, 'src/index.mjs'), '--mode', 'launch', '--headless'])}`);
        if (stack === 'browse') args.push('-c', 'mcp_servers.browse.command="cmd.exe"', '-c', `mcp_servers.browse.args=${JSON.stringify(['/d','/c',browse,'mcp'])}`);
        if (stack === 'browser-harness') args.push('-c', `mcp_servers.browser-harness.command=${JSON.stringify(browserUse)}`, '-c', 'mcp_servers.browser-harness.args=["--cli-mcp"]');
        args.push('-');
        if (host === 'claude') {
          // Claude Code host: same prompt and stacks; no user settings, skills or CLAUDE.md; only the stack's MCP server.
          const mcpServers = {};
          if (stack === 'turbo') mcpServers.turbo = { command: 'node', args: [path.join(repo, 'src/index.mjs'), '--mode', 'launch', '--headless'] };
          if (stack === 'browse') mcpServers.browse = { command: 'cmd.exe', args: ['/d', '/c', browse, 'mcp'] };
          if (stack === 'browser-harness') mcpServers['browser-harness'] = { command: browserUse, args: ['--cli-mcp'] };
          const mcpFile = path.join(workspace, 'mcp.json');
          fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers }));
          const cargs = ['-p', '--setting-sources', 'project', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', mcpFile, '--model', options['--model'], '--output-format', 'json', '--no-session-persistence', '--dangerously-skip-permissions', '--disallowedTools', 'WebFetch,WebSearch'];
          delete env.CODEX_HOME; env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
          execution = await execute(options['--claude'], cargs, { cwd: workspace, env, input: prompt, log, timeout: 600000 });
          try {
            const j = JSON.parse(execution.stdout.trim().split(/\r?\n/).at(-1));
            claudeJson = j;
            fs.writeFileSync(path.join(workspace, 'answer.txt'), j.result || '');
            if (j.is_error && /limit/i.test(j.result || '')) execution.usageLimit = true;
          } catch {}
        } else {
          execution = await execute(options['--codex'], args, { cwd: workspace, env, input: prompt, log });
        }
        const answer = fs.existsSync(path.join(workspace, 'answer.txt')) ? fs.readFileSync(path.join(workspace, 'answer.txt'), 'utf8') : '';
        fs.writeFileSync(prefix + '.answer.txt', answer);
        evaluation = await evaluateRemote(base, task, answer);
        if (execution.usageLimit) failure = 'usage limit';
        else if (execution.timedOut) failure = host === 'claude' ? 'timeout (600 seconds)' : 'timeout (360 seconds)';
        else if (execution.code !== 0) failure = execution.error || `${host} exit ${execution.code}`;
      } catch (e) { failure = `Setup/runner failure: ${e.message}`; }
      finally {
        if (stack === 'agent-browser') await execute('powershell.exe', ['-NoProfile', '-Command', `& '${agentBrowser.replaceAll("'", "''")}' close`], { cwd: workspace, env, timeout: 15000 });
        if ((stack === 'browse' || stack === 'browser-harness') && options['--hook']) {
          try { await hook('cleanup', stack, workspace, env); } catch (e) { failure = [failure, e.message].filter(Boolean).join('; '); }
        }
        // Trial credentials are not benchmark artifacts.
        fs.rmSync(path.join(homeDir, 'auth.json'), { force: true });
      }
      evaluation ||= await evaluateRemote(base, task, '');
      const tokenMatch = ((execution?.stdout || '') + '\n' + (execution?.stderr || '')).match(/tokens used\s*[:\r\n ]+([\d,]+)/i);
      fs.writeFileSync(prefix + '.evidence.json', JSON.stringify(evaluation.evidence, null, 2));
      const record = { stack, task, trial: 1, stackVersion: versions[stack] ?? null, engine: stack === 'browser-harness' ? 'browser-use' : stack, model: options['--model'], reasoning: options['--reasoning'] || 'medium', codexVersion, nodeVersion, os: `${os.platform()} ${os.release()}`, browserVersion: setup?.browserVersion || null, browserMode: setup?.browserMode || (['turbo','agent-browser'].includes(stack) ? 'headless' : null), seed: null, turns: null, toolCalls: null, inputTokens: null, outputTokens: null, cachedTokens: null, reasoningTokens: null, tokens: tokenMatch ? Number(tokenMatch[1].replaceAll(',', '')) : null, tokenMetric: 'Codex CLI tokens used (not independently verified provider total)', elapsedMs: execution?.elapsedMs ?? null, setupMs: setupMs ?? performance.now() - setupStart, success: !failure && evaluation.success, failureReason: failure || evaluation.failureReason, receipt: evaluation.receipt, finalCommitCount: evaluation.finalCommitCount, timedOut: execution?.timedOut ?? false, log: path.basename(log), workspace };
      if (claudeJson) {
        const u = claudeJson.usage || {};
        const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        Object.assign(record, { host: 'claude-code', turns: claudeJson.num_turns ?? null, inputTokens: inTok, outputTokens: u.output_tokens ?? null, cachedTokens: u.cache_read_input_tokens ?? null, tokens: inTok + (u.output_tokens || 0), costUsd: claudeJson.total_cost_usd ?? null, tokenMetric: 'Claude Code json usage of the main model: input + cache creation + cache read + output' });
      } else record.host = 'codex';
      fs.appendFileSync(path.join(resultsDir, 'results.jsonl'), JSON.stringify(record) + '\n');
      if (execution?.usageLimit) { console.log('Usage limit reached; stopping cleanly. Remaining trials were not run.'); break outer; }
    }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
