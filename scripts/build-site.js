'use strict';
// Copies the built single-file web app into site/ for GitHub Pages.
// Run `npm run build:site` after changing anything under web/ or core/.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'dist', 'web', 'app.html');
const outDir = path.join(root, 'site');
const target = path.join(outDir, 'index.html');

if (!fs.existsSync(source)) {
  console.error('缺少 dist/web/app.html，请先运行 npm run build:web');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(source, target);
fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
console.log(`site/index.html ← ${path.relative(root, source)} (${fs.statSync(target).size} B)`);
