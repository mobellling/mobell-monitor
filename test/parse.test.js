'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  parseBlogList, parsePostPage, parseRss, parseRssMeta, parseVercount,
  parseDiscussions, parseDiscussionsJson, parseCommitsJson, parseRepoContents,
} = require('../core/parse');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('parseBlogList finds five posts per listing page', () => {
  const first = parseBlogList(fixture('blog-1.html'));
  const second = parseBlogList(fixture('blog-2.html'));
  assert.equal(first.length, 5);
  assert.equal(second.length, 5);
  assert.ok(first.every((item) => item.path.startsWith('/') && item.title));
  assert.ok(!first.some((item) => item.path.startsWith('/blog')));
});

test('parsePostPage extracts title, date and word counts', () => {
  const post = parsePostPage(fixture('posts/linux.html'));
  assert.match(post.title, /安卓/);
  assert.equal(new Date(post.publishDate).toISOString(), '2026-10-31T12:00:00.000Z');
  assert.ok(post.cjk > 1500, `cjk=${post.cjk}`);
  assert.ok(post.words > 1500, `words=${post.words}`);
  assert.equal(post.words, post.cjk + post.latin);
});

test('parseRss reads all items and build date', () => {
  const xml = fixture('rss.xml');
  const items = parseRss(xml);
  assert.equal(items.length, 10);
  assert.ok(items[0].link.startsWith('https://mobellling.github.io/'));
  const meta = parseRssMeta(xml);
  assert.ok(meta.lastBuildDate);
});

test('parseVercount accepts JSON text and objects', () => {
  const data = parseVercount('{"data":{"site_uv":1,"site_pv":56,"page_pv":2}}');
  assert.deepEqual(data, { sitePv: 56, siteUv: 1, pagePv: 2 });
  assert.equal(parseVercount({ data: { site_pv: 7 } }).sitePv, 7);
  assert.equal(parseVercount('not json').sitePv, 0);
});

test('parseDiscussions maps terms to counts', () => {
  const parsed = parseDiscussions(fixture('discussions.html'));
  assert.equal(parsed.total, 11);
  assert.equal(parsed.byTerm.mat2, 1);
  assert.equal(parsed.byTerm['get-started-website-with-astro-tailwind-css'], 5);
  assert.equal(parsed.byTerm['gu4-shi4'], 2);
});

test('parseDiscussionsJson normalizes API payloads', () => {
  const parsed = parseDiscussionsJson([
    { title: 'linux/', comments: 3 },
    { title: 'post-two/', comments: 1 },
  ]);
  assert.equal(parsed.total, 4);
  assert.equal(parsed.byTerm.linux, 3);
});

test('parseCommitsJson returns first commit fields', () => {
  const commit = parseCommitsJson([
    {
      sha: 'abcdef1234567890',
      html_url: 'https://github.com/mobellling/mobellling.github.io/commit/abcdef',
      commit: { message: 'fix: 更新\n\nbody', author: { date: '2026-11-03T06:31:48Z' } },
    },
  ]);
  assert.equal(commit.sha, 'abcdef1234567890');
  assert.equal(commit.title, 'fix: 更新');
  assert.equal(commit.updated, '2026-11-03T06:31:48Z');
});

test('parseRepoContents handles arrays and encoding', () => {
  const files = parseRepoContents([{ name: 'a.md', path: 'src/a.md', sha: '1', size: 10, type: 'file' }]);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'a.md');
});
