// Production build: public/ -> dist/ with minified CSS/HTML and bundled, minified, obfuscated JS.
// Obfuscation is cosmetic (it slows down casual reading); the server's validation is the real security.
// Options that need eval/new Function (selfDefending, debugProtection, ...) stay off so the strict CSP holds.
import fs from 'node:fs/promises';
import * as esbuild from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';

const OUT = 'dist';
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT);

const js = await esbuild.build({
  entryPoints: ['public/app.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  legalComments: 'none',
  write: false,
});

const scrambled = JavaScriptObfuscator.obfuscate(js.outputFiles[0].text, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  renameGlobals: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 6,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 1,
  stringArrayWrappersType: 'function',
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
  // Off on purpose: these rely on eval-like code or break the page.
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
}).getObfuscatedCode();

if (/\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(/.test(scrambled))
  throw new Error('Obfuscated output uses eval/Function, which the CSP blocks.');
await fs.writeFile(`${OUT}/app.js`, scrambled);

const css = await esbuild.build({ entryPoints: ['public/style.css'], minify: true, write: false });
await fs.writeFile(`${OUT}/style.css`, css.outputFiles[0].text);

const html = (await fs.readFile('public/index.html', 'utf8'))
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/>\s*\n\s*</g, '><')
  .replace(/\s{2,}/g, ' ')
  .trim();
await fs.writeFile(`${OUT}/index.html`, html);

// App install assets are copied as-is.
for (const f of ['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'])
  await fs.copyFile(`public/${f}`, `${OUT}/${f}`);

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB';
console.log(`dist/app.js ${kb(scrambled)} · dist/style.css ${kb(css.outputFiles[0].text)} · dist/index.html ${kb(html)}`);
