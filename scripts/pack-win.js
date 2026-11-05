'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { packager } = require('@electron/packager');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const version = pkg.version;
const outDir = path.join(root, 'dist', 'windows');
const zipPath = path.join(outDir, `MobellMonitor-${version}-win64.zip`);

// Reuse the Electron zip downloaded by `npm install` when github.com is slow
// or unreachable; @electron/packager otherwise re-downloads it.
function findElectronZipDir(electronVersion) {
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'electron',
    'Cache',
  );
  if (!fs.existsSync(cacheRoot)) return null;
  const fileName = `electron-v${electronVersion}-win32-x64.zip`;
  for (const entry of fs.readdirSync(cacheRoot)) {
    const dir = path.join(cacheRoot, entry);
    if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, fileName))) return dir;
  }
  return null;
}

async function main() {
  if (!fs.existsSync(path.join(root, 'dist', 'web', 'app.html'))) {
    throw new Error('缺少 dist/web/app.html，请先运行 npm run build:web');
  }
  if (!fs.existsSync(path.join(root, 'build', 'icon.ico'))) {
    throw new Error('缺少 build/icon.ico，请先运行 npm run icon');
  }
  fs.mkdirSync(outDir, { recursive: true });
  const electronVersion = require('electron/package.json').version;
  const electronZipDir = findElectronZipDir(electronVersion);

  const appPaths = await packager({
    dir: root,
    out: outDir,
    name: 'MobellMonitor',
    appVersion: version,
    platform: 'win32',
    arch: 'x64',
    electronVersion,
    ...(electronZipDir ? { electronZipDir } : {}),
    icon: path.join(root, 'build', 'icon.ico'),
    overwrite: true,
    prune: true,
    asar: true,
    ignore: [
      /^\/android-app($|\/)/,
      /^\/ios-app($|\/)/,
      /^\/\.github($|\/)/,
      /^\/test($|\/)/,
      /^\/scripts($|\/)/,
      /^\/web($|\/)/,
      /^\/core($|\/)/,
      /^\/tmp($|\/)/,
      /^\/\.tools($|\/)/,
      /^\/dist\/windows($|\/)/,
      /^\/dist\/android($|\/)/,
      /^\/dist\/web\/app\.js$/,
      /^\/README-android\.md$/,
    ],
    win32metadata: {
      CompanyName: 'Mobell',
      FileDescription: 'Mobell 博客监控',
      ProductName: 'Mobell Monitor',
      OriginalFilename: 'MobellMonitor.exe',
      InternalName: 'MobellMonitor',
    },
  });

  const appPath = Array.isArray(appPaths) ? appPaths[0] : appPaths;
  console.log(`packaged: ${appPath}`);
  // Keep the README next to the exe so it is visible after unzipping.
  fs.copyFileSync(path.join(root, 'README.md'), path.join(appPath, 'README.md'));
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${appPath.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ],
    { stdio: 'inherit' },
  );
  console.log(`zip: ${zipPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
