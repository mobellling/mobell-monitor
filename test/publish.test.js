'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPostFiles, createPublisher, validateDraft, quoteYaml, extensionFor, PublishError,
} = require('../core/publish');

const baseDraft = {
  title: '测试文章',
  excerpt: '一篇用于测试的文章',
  body: '# 标题\n\n正文内容。',
  publishDate: '2026-11-03T12:00:00Z',
  category: 'Other',
  tags: ['测试', 'Node'],
  author: 'Mobell',
};

test('quoteYaml single quotes and escapes apostrophes', () => {
  assert.equal(quoteYaml("It's ok"), "'It''s ok'");
  assert.equal(quoteYaml('a\nb'), "'a b'");
});

test('extensionFor accepts known image types', () => {
  assert.equal(extensionFor('image/jpeg', 'x'), 'jpg');
  assert.equal(extensionFor('', 'cover.WEBP'), 'webp');
  assert.equal(extensionFor('application/pdf', 'x.pdf'), '');
});

test('validateDraft reports missing title/body and long excerpt', () => {
  const { errors } = validateDraft({ title: '', excerpt: 'x'.repeat(156), body: ' ' });
  assert.ok(errors.title);
  assert.ok(errors.excerpt);
  assert.ok(errors.body);
});

test('buildPostFiles emits frontmatter and post path', () => {
  const result = buildPostFiles(baseDraft, { siteUrl: 'https://mobellling.github.io' });
  assert.equal(result.slug, 'ce4-shi4-wen2-zhang1');
  assert.equal(result.postPath, 'src/data/post/ce4-shi4-wen2-zhang1.md');
  assert.equal(result.url, 'https://mobellling.github.io/ce4-shi4-wen2-zhang1/');
  assert.match(result.markdown, /^---\npublishDate: 2026-11-03T12:00:00\.000Z\n/);
  assert.match(result.markdown, /title: '测试文章'/);
  assert.match(result.markdown, /tags:\n  - '测试'\n  - 'Node'/);
  const post = result.files.find((file) => !file.binary);
  assert.ok(post.base64.length > 0);
  assert.equal(Buffer.from(post.base64, 'base64').toString('utf8'), result.markdown);
});

test('buildPostFiles adds cover upload and draft flag', () => {
  const result = buildPostFiles(Object.assign({}, baseDraft, {
    draft: true,
    cover: { mime: 'image/png', name: 'cover.png', size: 1024, base64: Buffer.from('fake').toString('base64') },
  }));
  const cover = result.files.find((file) => file.binary);
  assert.ok(cover);
  assert.match(cover.path, /^src\/assets\/images\/uploads\/ce4-shi4-wen2-zhang1-\d{14}\.png$/);
  assert.match(result.markdown, /image: '~\/src\/assets\/images\/uploads\//);
  assert.match(result.markdown, /draft: true/);
  assert.match(result.commitMessage, /保存草稿/);
});

test('buildPostFiles uses webp extension for converted covers', () => {
  const result = buildPostFiles(Object.assign({}, baseDraft, {
    cover: { mime: 'image/webp', name: 'photo.png', size: 1024, base64: Buffer.from('fake').toString('base64') },
  }));
  const cover = result.files.find((file) => file.binary);
  assert.ok(cover);
  assert.match(cover.path, /\.webp$/);
  assert.match(result.markdown, /image: '~\/src\/assets\/images\/uploads\/.+\.webp'/);
});

test('createPublisher performs atomic Git Data API sequence', async () => {
  const calls = [];
  const transport = {
    async request({ method, path, body }) {
      calls.push({ method, path, body });
      if (method === 'GET' && path.includes('/contents/')) return { status: 200, json: [] };
      if (method === 'GET' && path.endsWith('/git/ref/heads/master')) {
        return { status: 200, json: { object: { sha: 'head1' } } };
      }
      if (method === 'GET' && path.endsWith('/git/commits/head1')) {
        return { status: 200, json: { tree: { sha: 'tree1' } } };
      }
      if (method === 'POST' && path.endsWith('/git/blobs')) {
        return { status: 201, json: { sha: 'blob1' } };
      }
      if (method === 'POST' && path.endsWith('/git/trees')) {
        return { status: 201, json: { sha: 'tree2' } };
      }
      if (method === 'POST' && path.endsWith('/git/commits')) {
        return { status: 201, json: { sha: 'commit2' } };
      }
      if (method === 'PATCH' && path.endsWith('/git/refs/heads/master')) {
        return { status: 200, json: { object: { sha: 'commit2' } } };
      }
      return { status: 404, json: { message: 'unexpected ' + method + ' ' + path } };
    },
  };
  const publisher = createPublisher({ transport });
  const result = await publisher.publish(baseDraft);
  assert.equal(result.commitSha, 'commit2');
  assert.equal(result.postPath, 'src/data/post/ce4-shi4-wen2-zhang1.md');
  assert.match(result.commitUrl, /commit\/commit2$/);
  const order = calls.map((call) => call.method + ' ' + call.path.replace(/\?.*$/, ''));
  assert.ok(order.some((item) => item.endsWith('/git/blobs')));
  assert.ok(order.some((item) => item.endsWith('/git/trees')));
  assert.equal(order[order.length - 1], 'PATCH /repos/mobellling/mobellling.github.io/git/refs/heads/master');
  const tree = calls.find((call) => call.method === 'POST' && call.path.endsWith('/git/trees'));
  assert.equal(tree.body.base_tree, 'tree1');
  const commit = calls.find((call) => call.method === 'POST' && call.path.endsWith('/git/commits'));
  assert.equal(commit.body.parents[0], 'head1');
  assert.match(commit.body.message, /post: 添加《测试文章》/);
});

test('createPublisher rejects slug collisions with a suggestion', async () => {
  const transport = {
    async request({ method }) {
      assert.equal(method, 'GET');
      return {
        status: 200,
        json: [
          { name: 'hello.md', path: 'src/data/post/hello.md', sha: 'x', size: 1, type: 'file' },
          { name: 'hello-2.md', path: 'src/data/post/hello-2.md', sha: 'y', size: 1, type: 'file' },
        ],
      };
    },
  };
  const publisher = createPublisher({ transport });
  await assert.rejects(
    () => publisher.publish({ title: 'Hello', body: 'x' }),
    (error) => error instanceof PublishError && error.code === 'SLUG_EXISTS' && error.suggestedSlug === 'hello-3',
  );
});

test('createPublisher retries once when the ref update conflicts', async () => {
  let patches = 0;
  let trees = 0;
  const transport = {
    async request({ method, path }) {
      if (method === 'GET' && path.includes('/contents/')) return { status: 200, json: [] };
      if (method === 'GET' && path.endsWith('/git/ref/heads/master')) return { status: 200, json: { object: { sha: 'head1' } } };
      if (method === 'GET' && path.endsWith('/git/commits/head1')) return { status: 200, json: { tree: { sha: 'tree1' } } };
      if (method === 'POST' && path.endsWith('/git/blobs')) return { status: 201, json: { sha: 'blob1' } };
      if (method === 'POST' && path.endsWith('/git/trees')) { trees += 1; return { status: 201, json: { sha: 'tree2' } }; }
      if (method === 'POST' && path.endsWith('/git/commits')) return { status: 201, json: { sha: 'commit2' } };
      if (method === 'PATCH' && path.endsWith('/git/refs/heads/master')) {
        patches += 1;
        return patches === 1
          ? { status: 409, json: { message: 'Update is not a fast forward' } }
          : { status: 200, json: { object: { sha: 'commit2' } } };
      }
      return { status: 404, json: { message: 'unexpected' } };
    },
  };
  const publisher = createPublisher({ transport });
  const result = await publisher.publish(baseDraft);
  assert.equal(result.commitSha, 'commit2');
  assert.equal(patches, 2);
  assert.equal(trees, 2);
});
