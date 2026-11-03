'use strict';

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist', 'web');

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(root, 'web', 'app.js')],
    bundle: true,
    outfile: path.join(outDir, 'app.js'),
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  });

  const js = fs.readFileSync(path.join(outDir, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'web', 'styles.css'), 'utf8');
  const template = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
  const safeJs = js.replace(/<\/script/gi, '<\\/script');
  const html = template
    .replace('/*__STYLE__*/', () => css)
    .replace('/*__APP__*/', () => safeJs);
  const target = path.join(outDir, 'app.html');
  fs.writeFileSync(target, html, 'utf8');
  fs.writeFileSync(path.join(outDir, 'app.js'), safeJs, 'utf8');
  const size = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`built ${target} (${size} KB)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
