// The one place that says where Re-Prompt's shared settings live (JavaScript side; Python: default_data_dir() in reprompt_engine.py).
// Order: REPROMPT_DATA_DIR / PLUGIN_DATA, then the Watchkeeper folder when it exists, then the old per-platform default.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const watchkeeperDataDir = () => path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'watchkeeper');
export const platformDataDir = () => process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 're-prompt')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 're-prompt')
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 're-prompt');
// "~" and "~/x" mean the home folder, the same as Python's expanduser in default_data_dir(); otherwise the store splits in two.
export const expandHome = p => p === '~' ? os.homedir() : /^~[\/]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p;
export function resolveDataDir() {
  const env = process.env.REPROMPT_DATA_DIR || process.env.PLUGIN_DATA;
  if (env) return expandHome(env);
  const wk = watchkeeperDataDir();
  try { if (fs.statSync(wk).isDirectory()) return wk; } catch {}
  return platformDataDir();
}
