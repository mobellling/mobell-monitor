'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  buildVercountUrl, fetchSiteCounts, fetchPostViews, discoverPosts, fetchComments, fetchLatestCommit,
} = require('../core/sources');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const SITE = 'https://mobellling.github.io';
const ENDPOINT = 'https://events.vercount.one/api/v2/log';

test('buildVercountUrl encodes the full site URL', () => {
  const url = buildVercountUrl(ENDPOINT, `${SITE}/linux/`);
  assert.equal(url, `${ENDPOINT}?url=${encodeURIComponent(`${SITE}/linux/`)}`);
});

test('fetchSiteCounts parses site pv and uv', async () => {
  let requested = '';
  const result = await fetchSiteCounts({
    httpText: async (url) => {
      requested = url;
      return '{"data":{"site_pv":56,"site_uv":1,"page_pv":23}}';
    },
    siteUrl: SITE,
    endpoint: ENDPOINT,
  });
  assert.deepEqual(result, { sitePv: 56, siteUv: 1 });
  assert.equal(requested, buildVercountUrl(ENDPOINT, `${SITE}/`));
});

test('fetchPostViews collects views and reports failures', async () => {
  const posts = [
    { slug: 'linux', url: `${SITE}/linux/` },
    { slug: 'mat2', url: `${SITE}/mat2/` },
    { slug: 'broken', url: `${SITE}/broken/` },
  ];
  const result = await fetchPostViews({
    httpText: async (url) => {
      if (url.includes('broken')) throw new Error('network down');
      if (url.includes('linux')) return '{"data":{"page_pv":2}}';
      return '{"data":{"page_pv":1}}';
    },
    endpoint: ENDPOINT,
    posts,
    concurrency: 1,
    gapMs: 0,
  });
  assert.deepEqual(result.views, { linux: 2, mat2: 1 });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].slug, 'broken');
});

test('discoverPosts walks listing pages and maps slugs', async () => {
  const urls = [];
  const posts = await discoverPosts({
    httpText: async (url) => {
      urls.push(url);
      if (url === `${SITE}/blog/`) return fixture('blog-1.html');
      if (url === `${SITE}/blog/2/`) return fixture('blog-2.html');
      throw new Error('404');
    },
    siteUrl: SITE,
    maxPages: 5,
  });
  assert.equal(posts.length, 10);
  assert.ok(posts.some((post) => post.slug === 'linux' && post.url === `${SITE}/linux/`));
  assert.equal(urls.length, 3);
});

test('fetchComments falls back to GitHub HTML when the API fails', async () => {
  const result = await fetchComments({
    github: async () => ({ status: 403, json: { message: 'rate limit' } }),
    httpText: async (url) => {
      assert.match(url, /^https:\/\/github\.com\/mobellling\/mobellling\.github\.io\/discussions/);
      return fixture('discussions.html');
    },
    repo: 'mobellling/mobellling.github.io',
    maxPages: 1,
  });
  assert.equal(result.total, 11);
  assert.equal(result.byTerm.mat2, 1);
  assert.equal(result.source, 'html');
});

test('fetchComments prefers the API transport when available', async () => {
  const result = await fetchComments({
    github: async (path) => {
      assert.match(path, /^\/repos\/mobellling\/mobellling\.github\.io\/discussions/);
      return { status: 200, json: [{ title: 'linux/', comments: 4 }] };
    },
    httpText: async () => { throw new Error('should not be called'); },
    repo: 'mobellling/mobellling.github.io',
    maxPages: 1,
  });
  assert.equal(result.total, 4);
  assert.equal(result.byTerm.linux, 4);
  assert.equal(result.source, 'api');
});

test('fetchLatestCommit falls back to RSS build time', async () => {
  const result = await fetchLatestCommit({
    github: async () => ({ status: 403, json: { message: 'rate limit' } }),
    httpText: async (url) => {
      assert.equal(url, `${SITE}/rss.xml`);
      return fixture('rss.xml');
    },
    repo: 'mobellling/mobellling.github.io',
    siteUrl: SITE,
  });
  assert.equal(result.source, 'rss');
  assert.equal(result.sha, '');
  assert.ok(result.updated);
  assert.ok(!Number.isNaN(new Date(result.updated).getTime()));
});
