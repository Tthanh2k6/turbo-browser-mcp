import os from 'node:os';
import path from 'node:path';

/** State folder for the bridge token files, the submission ledger and the default Chrome profile. */
export function turboHome() {
  return process.env.TURBO_BROWSER_HOME ? path.resolve(process.env.TURBO_BROWSER_HOME) : path.join(os.homedir(), '.turbo-browser-mcp');
}
