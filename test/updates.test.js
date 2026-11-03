'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseVersion, compareVersions, isNewer, pickAsset, parseRelease, checkForUpdate,
} = require('../core/updates');

const RELEASE = {
  tag_name: 'v1.2.3',
  name: 'Mobell 博客监控 v1.2.3',
  body: '修复评论读取，增加检查更新。',
  html_url: 'https://github.com/mobellling/mobell-monitor/releases/tag/v1.2.3',
  published_at: '2026-11-04T00:00:00Z',
  assets: [
    { name: 'MobellMonitor-1.2.3-win64.zip', size: 158000000, browser_download_url: 'https://example.com/win.zip' },
    { name: 'MobellMonitor-1.2.3.apk', size: 2200000, browser_download_url: 'https://example.com/app.apk' },
    { name: 'MobellMonitor-1.2.3-ios.ipa', size: 3000000, browser_download_url: 'https://example.com/app.ipa' },
  ],
};

test('parseVersion extracts three numeric parts', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('monitor-v10.0.12'), [10, 0, 12]);
  assert.equal(parseVersion('latest'), null);
});

test('compareVersions and isNewer work across parts', () => {
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(isNewer('1.2.3', '1.2.2'), true);
  assert.equal(isNewer('1.2.3', '1.2.3'), false);
  assert.equal(isNewer('v1.2.3', '1.2.4'), false);
});

test('pickAsset matches the platform extension', () => {
  assert.equal(pickAsset(RELEASE.assets, 'windows').name, 'MobellMonitor-1.2.3-win64.zip');
  assert.equal(pickAsset(RELEASE.assets, 'android').name, 'MobellMonitor-1.2.3.apk');
  assert.equal(pickAsset(RELEASE.assets, 'ios').name, 'MobellMonitor-1.2.3-ios.ipa');
  assert.equal(pickAsset(RELEASE.assets, 'browser'), null);
});

test('parseRelease tolerates JSON strings and missing assets', () => {
  const release = parseRelease(JSON.stringify(RELEASE), 'android');
  assert.equal(release.version, 'v1.2.3');
  assert.equal(release.asset.url, 'https://example.com/app.apk');
  assert.equal(parseRelease('not json', 'android'), null);
  assert.equal(parseRelease({ tag_name: 'no-version' }, 'android'), null);
  const bare = parseRelease({ tag_name: 'v1.0.0' }, 'windows');
  assert.equal(bare.asset, null);
});

test('checkForUpdate detects a newer release and picks the asset', async () => {
  let requested = '';
  const result = await checkForUpdate({
    httpText: async (url) => {
      requested = url;
      return JSON.stringify(RELEASE);
    },
    repo: 'mobellling/mobell-monitor',
    currentVersion: '1.1.0',
    kind: 'android',
  });
  assert.equal(requested, 'https://api.github.com/repos/mobellling/mobell-monitor/releases/latest');
  assert.equal(result.checked, true);
  assert.equal(result.newer, true);
  assert.equal(result.latestVersion, 'v1.2.3');
  assert.equal(result.downloadUrl, 'https://example.com/app.apk');
  assert.match(result.release.notes, /修复评论/);
});

test('checkForUpdate treats 404 as no release, other errors as failures', async () => {
  const notFound = await checkForUpdate({
    httpText: async () => { throw new Error('HTTP 404'); },
    repo: 'mobellling/mobell-monitor',
    currentVersion: '1.1.0',
    kind: 'windows',
  });
  assert.equal(notFound.checked, true);
  assert.equal(notFound.newer, false);
  assert.equal(notFound.release, null);

  const failed = await checkForUpdate({
    httpText: async () => { throw new Error('请求超时'); },
    repo: 'mobellling/mobell-monitor',
    currentVersion: '1.1.0',
    kind: 'windows',
  });
  assert.equal(failed.checked, false);
  assert.match(failed.error, /检查更新失败/);
});

test('checkForUpdate reports same and older versions as not newer', async () => {
  const same = await checkForUpdate({
    httpText: async () => JSON.stringify({ ...RELEASE, tag_name: 'v1.1.0' }),
    repo: 'mobellling/mobell-monitor',
    currentVersion: '1.1.0',
    kind: 'ios',
  });
  assert.equal(same.newer, false);
});
