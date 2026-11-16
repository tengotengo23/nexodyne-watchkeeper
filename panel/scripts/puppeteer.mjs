// Dev-time only: puppeteer is no dependency of this extension. It comes from WK_PUPPETEER_FROM (a package.json whose folder has it),
// else from the panel folder itself (npm i --no-save puppeteer in panel/).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const where = process.env.WK_PUPPETEER_FROM ? path.resolve(process.env.WK_PUPPETEER_FROM) : path.join(PANEL, 'package.json');
function load() {
  try { return createRequire(where)('puppeteer'); } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    process.stderr.write('puppeteer is not installed: run npm i --no-save puppeteer in panel/, or set WK_PUPPETEER_FROM to a package.json whose folder has it\n');
    process.exit(1);
  }
}
export const puppeteer = load();
export const launch = () => puppeteer.launch({ headless: true, args: ['--no-sandbox', '--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2'] });
