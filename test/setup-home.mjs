// Preloaded by `npm test` (node --import): tests must never write into the real ~/.turbo-browser-mcp.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.TURBO_BROWSER_HOME) {
  process.env.TURBO_BROWSER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tbm-home-'));
}
