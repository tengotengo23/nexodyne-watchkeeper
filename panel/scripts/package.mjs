// Builds dist/watchkeeper-panel-<version>.vsix with no dependencies: the standard VSIX layout zipped with the system `zip`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.env.WK_VSIX_DIR ? path.resolve(process.env.WK_VSIX_DIR) : path.join(root, '..', 'dist');   // WK_VSIX_DIR: a trial build elsewhere
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// Every file the extension loads: test/extension.test.js checks that each relative require() is in this list.
const FILES = ['package.json', 'README.md', 'LICENSE.txt', 'extension.js', 'src/data.js', 'src/render.js', 'src/actions.js', 'src/legal-words.js', 'media/main.css', 'media/main.js', 'media/w.svg', 'media/icon.png'];
const x = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-vsix-'));
for (const f of FILES) {
  const src = path.join(root, f);
  if (!fs.existsSync(src)) throw new Error(`missing ${f} (run scripts/icon.mjs for media/icon.png)`);
  fs.mkdirSync(path.dirname(path.join(stage, 'extension', f)), { recursive: true });
  fs.copyFileSync(src, path.join(stage, 'extension', f));
}
// README.md is the store listing (Open VSX shows it); LICENSE.txt is the MIT licence.

const exts = [...new Set(FILES.map(f => path.extname(f).slice(1)))];
const TYPES = { json: 'application/json', js: 'application/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', md: 'text/markdown', txt: 'text/plain' };
fs.writeFileSync(path.join(stage, '[Content_Types].xml'), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".vsixmanifest" ContentType="text/xml"/>${exts.map(e => `<Default Extension=".${e}" ContentType="${TYPES[e]}"/>`).join('')}</Types>
`);
fs.writeFileSync(path.join(stage, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${x(pkg.name)}" Version="${x(pkg.version)}" Publisher="${x(pkg.publisher)}"/>
    <DisplayName>${x(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${x(pkg.description)}</Description>
    <Tags>${x(pkg.keywords.join(','))}</Tags>
    <Categories>${x(pkg.categories.join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${x(pkg.engines.vscode)}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/>
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true"/>
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/media/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true"/>
  </Assets>
</PackageManifest>
`);

fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, `${pkg.name}-${pkg.version}.vsix`);
fs.rmSync(out, { force: true });
execFileSync('zip', ['-q', '-X', '-r', out, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], { cwd: stage, stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`${out} ${fs.statSync(out).size} bytes`);
