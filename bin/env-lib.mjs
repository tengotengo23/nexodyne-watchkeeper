// What computer Watchkeeper runs on, and the commands that suit it (P2-282).
// detectEnv() names the system, the shell, Node.js and Python, the folders, the scheduler, and fills the command
// table in config/platforms.json for this computer. `wk env` prints it; the W panel reads the same table.
// Pure: importing this file does nothing; every reader (os-release, PATH lookup) can be passed in, so tests run anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '..');
export const PLATFORMS_FILE = path.join(PLUGIN_ROOT, 'config', 'platforms.json');
export const COMMAND_KEYS = ['stop', 'resume', 'inbox', 'take', 'done', 'watch_install', 'watch_uninstall', 'status', 'logs'];

let cache = null;
const table = () => (cache ||= JSON.parse(fs.readFileSync(PLATFORMS_FILE, 'utf8')));

// The entry for macos | linux | windows | wsl; wsl takes the linux commands under its own name.
export function platformTable(osName) {
  const t = table(), e = t[osName];
  if (!e) throw new Error(`config/platforms.json has no entry for ${osName}`);
  if (e.fallback) return { ...t[e.fallback], ...Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'fallback')), commands: { ...t[e.fallback].commands } };
  return { ...e, commands: { ...e.commands } };
}

// Quotes a word for the shell the command is pasted into: sh single quotes, or PowerShell single quotes.
const NEEDS_QUOTE = /[\s'"$`&|;()<>*?!#~%^,{}[\]]/;
export function quote(s, style = 'sh') {
  s = String(s);
  return style === 'powershell' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`;
}

// Fills <NODE>, <ABS>, <WK_HOME>, <HOME> (any <UPPER_CASE> key of values). A word the template already quotes is
// filled as it is; any other word that ends up holding a space or a shell sign is quoted as a whole.
// Unknown placeholders such as <task-id> stay as written.
export function fillCommand(template, values = {}, { style = 'sh' } = {}) {
  const ph = /<([A-Z_]+)>/g;
  return String(template).split(/(\s+)/).map(word => {
    if (!ph.test(word)) return word;
    ph.lastIndex = 0;
    const filled = word.replace(ph, (all, k) => (values[k] === undefined || values[k] === null ? all : String(values[k])));
    if (/^['"]/.test(word)) return filled;
    return NEEDS_QUOTE.test(filled.replace(/<[A-Za-z_-]+>/g, '')) ? quote(filled, style) : filled;
  }).join('');
}

// The shell wk-task uses to run a task's test command.
export function testShell(platform = process.platform) {
  return platform === 'win32' ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'] } : { file: '/bin/sh', args: ['-c'] };
}

// Finds a program on PATH (with PATHEXT on Windows). Skips the Windows Store python stubs in \WindowsApps\.
export function makeLookup({ env = process.env, platform = process.platform } = {}) {
  const win = platform === 'win32', sep = win ? ';' : ':', join = win ? path.win32.join : path.posix.join;
  const exts = win ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  return name => {
    for (const d of String(env.PATH || env.Path || '').split(sep).filter(Boolean)) {
      if (win && /\\WindowsApps\\?$/i.test(d)) continue;
      for (const x of exts) {
        const p = join(d, name + x);
        try { if (fs.statSync(p).isFile()) { if (!win) fs.accessSync(p, fs.constants.X_OK); return p; } } catch {}
      }
    }
    return null;
  };
}

// python3, then python; on Windows python, python3, then the py launcher as "py -3".
export function findPythonPath({ platform = process.platform, env = process.env, lookup = makeLookup({ env, platform }) } = {}) {
  if (env.WK_PYTHON) return env.WK_PYTHON;
  const names = platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const n of names) { const p = lookup(n); if (p && !/\\WindowsApps\\/i.test(p)) return p; }
  if (platform === 'win32') { const py = lookup('py'); if (py) return `${py} -3`; }
  return null;
}

function readOsReleaseFile() {
  for (const f of ['/etc/os-release', '/usr/lib/os-release']) { try { return fs.readFileSync(f, 'utf8'); } catch {} }
  return '';
}
export function parseOsRelease(text) {
  const o = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) o[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return o;
}

// Darwin kernel major -> macOS version: 20-24 are macOS 11-15, from 25 Apple numbers macOS by year (26, 27, ...).
export function macosWords(release) {
  const d = parseInt(release, 10);
  if (!Number.isFinite(d)) return 'macOS';
  return `macOS ${d >= 25 ? d + 1 : d >= 20 ? d - 9 : `10.${d - 4}`}`;
}
// Windows 11 reports 10.0 with build 22000 or later.
export function windowsWords(release) {
  const [maj, , build] = String(release || '').split('.').map(Number);
  if (maj === 10) return build >= 22000 ? 'Windows 11' : 'Windows 10';
  return maj ? `Windows (version ${release})` : 'Windows';
}
export function linuxWords(osRelease) {
  const o = parseOsRelease(osRelease);
  const name = o.NAME || 'Linux';
  return o.VERSION_ID ? `${name} ${o.VERSION_ID}` : (o.PRETTY_NAME || name);
}

function shellOf(osName, env) {
  if (osName === 'windows') {
    // PowerShell adds the user's own module folder to PSModulePath; cmd only has the system-wide one (two entries at most).
    const ps = String(env.PSModulePath || '').split(';').filter(Boolean);
    if (ps.length >= 3 || /\\Documents\\(Windows)?PowerShell\\Modules/i.test(env.PSModulePath || '')) return 'powershell';
    return /cmd\.exe$/i.test(env.ComSpec || '') ? 'cmd' : 'powershell';
  }
  const s = path.posix.basename(String(env.SHELL || ''));
  return ['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh'].includes(s) ? s : 'sh';
}

export function detectEnv({
  platform = process.platform, env = process.env, home, release = os.release(), argv0 = process.execPath,
  nodeVersion = process.version, readOsRelease = readOsReleaseFile, lookup, pluginRoot = PLUGIN_ROOT,
} = {}) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  home = home || env.HOME || (win ? env.USERPROFILE : '') || os.homedir();
  let osName = platform === 'darwin' ? 'macos' : win ? 'windows' : 'linux';
  let osWords;
  if (osName === 'macos') osWords = macosWords(release);
  else if (osName === 'windows') osWords = windowsWords(release);
  else {
    if (/microsoft|wsl/i.test(String(release)) || env.WSL_DISTRO_NAME) osName = 'wsl';
    osWords = linuxWords(readOsRelease()) + (osName === 'wsl' ? ' (WSL)' : '');
  }
  const t = platformTable(osName);
  const wkHome = env.WK_HOME ? p.resolve(env.WK_HOME) : p.join(home, '.wk');
  const python = findPythonPath({ platform, env, lookup: lookup || makeLookup({ env, platform }) });
  const style = win ? 'powershell' : 'sh';
  const values = { NODE: argv0, ABS: pluginRoot, WK_HOME: wkHome, HOME: home };
  const commands = Object.fromEntries(COMMAND_KEYS.map(k => [k, fillCommand(t.commands[k], values, { style })]));
  return {
    os: osName, osWords, shell: shellOf(osName, env), node: { path: argv0, version: nodeVersion }, python,
    home, wkHome, pluginRoot, antigravityPluginDir: p.join(home, '.gemini', 'config', 'plugins'),
    scheduler: t.scheduler, stopFileDisplay: t.stop_file_display, commands,
  };
}

// The text `wk env` prints.
export function envText(e) {
  const width = Math.max(...COMMAND_KEYS.map(k => k.length)) + 2;
  return [
    `Your computer: ${e.osWords}, shell ${e.shell}, node ${e.node.version}, python ${e.python || 'not found'}`,
    `Watchkeeper folder: ${e.pluginRoot}`,
    `Watchkeeper data (~/.wk): ${e.wkHome}`,
    `Antigravity plugins: ${e.antigravityPluginDir}`,
    `Scheduler for the checker: ${e.scheduler}`,
    `Stop switch: ${e.stopFileDisplay}`,
    '',
    'Commands for this computer:',
    ...COMMAND_KEYS.map(k => `  ${(k + ':').padEnd(width)}${e.commands[k]}`),
  ].join('\n');
}
