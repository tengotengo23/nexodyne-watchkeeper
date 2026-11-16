// Renders media/icon.png (128 x 128) from media/w-colour.svg, and a preview sheet of the Activity Bar mask at 16, 24 and 48 px.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './puppeteer.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..');
const screens = path.join(root, '..', 'dist', 'screens'); fs.mkdirSync(screens, { recursive: true });
const colour = fs.readFileSync(path.join(root, 'media/w-colour.svg'), 'utf8');
const mono = fs.readFileSync(path.join(root, 'media/w.svg'), 'utf8');
const b = await launch();
try {
  const p = await b.newPage();
  await p.setViewport({ width: 128, height: 128, deviceScaleFactor: 1 });
  await p.setContent(`<html><body style="margin:0;background:transparent">${colour}</body></html>`);
  await p.screenshot({ path: path.join(root, 'media/icon.png'), omitBackground: true, clip: { x: 0, y: 0, width: 128, height: 128 } });
  const uri = 'data:image/svg+xml;base64,' + Buffer.from(mono).toString('base64');
  const cell = (bg, fg, s) => `<div style="background:${bg};padding:12px;display:inline-block"><div style="width:${s}px;height:${s}px;background:${fg};-webkit-mask:url(${uri}) center/contain no-repeat"></div></div>`;
  await p.setViewport({ width: 420, height: 160, deviceScaleFactor: 2 });
  await p.setContent(`<html><body style="margin:0;font:12px sans-serif">${[16, 24, 48].map(s => cell('#181818', '#cccccc', s)).join('')}${[16, 24, 48].map(s => cell('#f3f3f3', '#424242', s)).join('')}<br>${cell('#ffffff', 'transparent', 0).replace('<div style="width:0px', '<img src="' + 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'media/icon.png')).toString('base64') + '" width="64"><div style="width:0px')}</body></html>`);
  await p.screenshot({ path: path.join(screens, 'icon-preview.png'), fullPage: true });
  console.log('icon.png', fs.statSync(path.join(root, 'media/icon.png')).size, 'bytes; preview', path.join(screens, 'icon-preview.png'));
} finally { await b.close(); }
