// Builds the browser extension (Edge and Chrome) into dist/edge from the same code the local server runs:
//   node edge/build.mjs
// Then load dist/edge with "Load unpacked", or hand out dist/yiju-extension-<version>.zip.
// This folder is the source, not an extension: its manifest is only a template, so it cannot be loaded by mistake.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url)), out = join(root, 'dist/edge');
const from = (...p) => join(root, ...p), to = (...p) => join(out, ...p);
rmSync(out, { recursive: true, force: true });
mkdirSync(to('web'), { recursive: true }); mkdirSync(to('server'), { recursive: true });
// Extensions serve .js reliably, so .mjs is renamed, and so is every import of it.
const renamed = code => code.replace(/(from\s+'\.{1,2}\/[^']+)\.mjs'/g, "$1.js'");

// The engine: whatever the extension's backend imports from the server, and what those import in turn.
const engine = new Set(), queue = [...readFileSync(from('edge/backend.js'), 'utf8').matchAll(/from '\.\.\/server\/([\w-]+)\.js'/g)].map(m => m[1]);
while (queue.length) {
  const name = queue.pop();
  if (engine.has(name)) continue;
  engine.add(name);
  const code = readFileSync(from('studio/server', `${name}.mjs`), 'utf8');
  if (/from 'node:/.test(code)) throw new Error(`studio/server/${name}.mjs imports a Node module; it cannot run in the extension`);
  queue.push(...[...code.matchAll(/from '\.\/([\w-]+)\.mjs'/g)].map(m => m[1]));
  writeFileSync(to('server', `${name}.js`), renamed(code));
}

// The page, with the extension's backend in place of the HTTP one. The old theme practice (/legacy) stays local.
const LEGACY = new Set(['app.js', 'index.html', 'style.css', 'backend.js']);
for (const file of readdirSync(from('studio/web'))) {
  if (LEGACY.has(file)) continue;
  if (/\.m?js$/.test(file)) writeFileSync(to('web', file.replace(/\.mjs$/, '.js')), renamed(readFileSync(from('studio/web', file), 'utf8')));
  else cpSync(from('studio/web', file), to('web', file));
}
for (const file of ['backend.js', 'store.js', 'rtc.js', 'speech-cache.js']) cpSync(from('edge', file), to('web', file));
// Text meant for the local server is swapped for the extension's (<!-- local-only -->…<!-- /local-only --><!-- edge: … -->).
const html = readFileSync(from('studio/web/sentence.html'), 'utf8')
  .replace(/<!-- local-only -->[\s\S]*?<!-- \/local-only -->(\s*<!-- edge: ([\s\S]*?) -->)?/g, (all, edge, text) => text || '')
  .replace(/<!-- edge: ([\s\S]*?) -->/g, '$1');
writeFileSync(to('web/sentence.html'), html);

// The prompts, bundled; the local server reads the same files from studio/prompts/.
const prompts = Object.fromEntries(readdirSync(from('studio/prompts')).filter(f => f.endsWith('.txt')).map(f => [f.slice(0, -4), readFileSync(from('studio/prompts', f), 'utf8')]));
writeFileSync(to('prompts.js'), `// Built from studio/prompts/*.txt by edge/build.mjs.\nexport default ${JSON.stringify(prompts, null, 1)};\n`);

cpSync(from('edge/manifest.template.json'), to('manifest.json'));
for (const file of ['background.js', 'permission.html', 'permission.js']) cpSync(from('edge', file), to(file));
cpSync(from('edge/icons'), to('icons'), { recursive: true });

// Name, description and titles come from _locales: the store offers a listing for each language found there.
const manifest = JSON.parse(readFileSync(from('edge/manifest.template.json'), 'utf8'));
const locales = readdirSync(from('edge/_locales'));
if (!locales.includes(manifest.default_locale)) throw new Error(`_locales has no ${manifest.default_locale}, the default locale`);
const used = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map(m => m[1]).concat(
  [...readFileSync(from('edge/background.js'), 'utf8').matchAll(/getMessage\('(\w+)'\)/g)].map(m => m[1]));
for (const locale of locales) {
  const messages = JSON.parse(readFileSync(from('edge/_locales', locale, 'messages.json'), 'utf8'));
  for (const key of used) if (!messages[key]?.message) throw new Error(`_locales/${locale} has no ${key}`);
  if ([...messages.extensionDescription.message].length > 132) throw new Error(`_locales/${locale}: the description is over 132 characters`);
}
cpSync(from('edge/_locales'), to('_locales'), { recursive: true });

// Every relative import in the package must land on a file in it, and nothing may reach for Node.
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
for (const file of files(out).filter(f => f.endsWith('.js'))) {
  const code = readFileSync(file, 'utf8');
  if (/from\s+'node:|import\('node:/.test(code)) throw new Error(`${relative(out, file)} reaches for Node`);
  for (const [, spec] of code.matchAll(/(?:from\s+|import\()'(\.{1,2}\/[^']+)'/g)) {
    if (!existsSync(join(dirname(file), spec))) throw new Error(`${relative(out, file)} imports ${spec}, which is not in the package`);
  }
}

const zip = join(root, `dist/yiju-extension-${manifest.version}.zip`);
rmSync(zip, { force: true });
execFileSync('zip', ['-qr', zip, '.'], { cwd: out });
console.log(`built ${out} (${engine.size} engine modules)\nzipped ${zip}`);
