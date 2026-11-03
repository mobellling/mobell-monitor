'use strict';

const { safeParseJson, truncate } = require('./util');

const DEFAULT_API = 'https://api.github.com';

function parseVersion(value) {
  const match = String(value == null ? '' : value).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}

function extensionFor(kind) {
  if (kind === 'windows') return '.zip';
  if (kind === 'android') return '.apk';
  if (kind === 'ios') return '.ipa';
  return null;
}

function pickAsset(assets, kind) {
  const extension = extensionFor(kind);
  if (!extension || !Array.isArray(assets)) return null;
  return assets.find((asset) => {
    const name = String((asset && asset.name) || '').toLowerCase();
    return name.endsWith(extension);
  }) || null;
}

function parseRelease(input, kind) {
  const release = typeof input === 'string' ? safeParseJson(input, null) : input;
  if (!release || typeof release !== 'object') return null;
  const version = release.tag_name || release.name || '';
  if (!parseVersion(version)) return null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = pickAsset(assets, kind);
  return {
    version: String(version),
    name: String(release.name || version),
    notes: truncate(String(release.body || ''), 600),
    htmlUrl: release.html_url || '',
    publishedAt: release.published_at || '',
    asset: asset
      ? {
          name: asset.name,
          url: asset.browser_download_url || '',
          size: Number(asset.size) || 0,
        }
      : null,
  };
}

async function checkForUpdate({ httpText, repo, currentVersion, kind, apiBase }) {
  if (!repo) return { checked: false, error: '未配置更新仓库', newer: false };
  const base = apiBase || DEFAULT_API;
  const url = `${base}/repos/${repo}/releases/latest`;
  let text;
  try {
    text = await httpText(url);
  } catch (error) {
    const message = String((error && error.message) || error);
    if (/HTTP 404/.test(message)) {
      return { checked: true, newer: false, latestVersion: null, release: null };
    }
    return { checked: false, error: `检查更新失败：${message}`, newer: false };
  }
  const release = parseRelease(text, kind);
  if (!release) return { checked: true, newer: false, latestVersion: null, release: null };
  return {
    checked: true,
    newer: isNewer(release.version, currentVersion),
    latestVersion: release.version,
    release,
    downloadUrl: release.asset ? release.asset.url : '',
  };
}

module.exports = {
  parseVersion,
  compareVersions,
  isNewer,
  pickAsset,
  parseRelease,
  checkForUpdate,
};
