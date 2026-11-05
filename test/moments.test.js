'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateMoment, buildMomentFiles, createMomentPublisher, momentId,
} = require('../core/moments');

const image = {
  mime: 'image/png',
  name: 'photo.png',
  size: 1024,
  base64: Buffer.from('fake-image').toString('base64'),
};

const baseDraft = {
  text: '今天的天空很好看。',
  date: '2026-11-05T20:30:00+08:00',
  images: [],
};

test('momentId uses UTC second precision', () => {
  assert.equal(momentId('2026-11-05T20:30:00+08:00'), '20261105123000');
});

test('validateMoment requires text and enforces limits', () => {
  assert.ok(validateMoment({ text: ' ' }).errors.text);
  assert.ok(validateMoment({ text: 'x'.repeat(2001) }).errors.text);
  assert.ok(validateMoment({ text: 'hi', images: new Array(7).fill(image) }).errors.images);
  assert.ok(validateMoment({ text: 'hi', images: [{ mime: 'application/pdf', name: 'a.pdf', size: 1 }] }).errors.images);
});

test('buildMomentFiles emits frontmatter with date and image paths', () => {
  const result = buildMomentFiles(Object.assign({}, baseDraft, { images: [image] }), {
    siteUrl: 'https://mobellling.github.io',
  });
  assert.equal(result.id, '20261105123000');
  assert.equal(result.url, 'https://mobellling.github.io/moments/20261105123000/');
  assert.match(result.markdown, /^---\ndate: 2026-11-05T12:30:00\.000Z\nimages:\n  - '\/images\/moments\/20261105123000-1\.png'\n---\n\n今天的天空很好看。/);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0].path, 'src/data/moments/20261105123000.md');
  assert.equal(result.files[1].path, 'public/images/moments/20261105123000-1.png');
  assert.equal(result.commitMessage, 'moments: 添加动态 2026-11-05');
});

test('buildMomentFiles emits webp paths for converted images', () => {
  const webp = { mime: 'image/webp', name: 'photo.png', size: 1024, base64: Buffer.from('fake-image').toString('base64') };
  const result = buildMomentFiles(Object.assign({}, baseDraft, { images: [webp] }), {
    siteUrl: 'https://mobellling.github.io',
  });
  assert.match(result.markdown, /20261105123000-1\.webp/);
  assert.equal(result.files[1].path, 'public/images/moments/20261105123000-1.webp');
});

test('createMomentPublisher commits markdown and images atomically', async () => {
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
      if (method === 'POST' && path.endsWith('/git/blobs')) return { status: 201, json: { sha: `blob${calls.length}` } };
      if (method === 'POST' && path.endsWith('/git/trees')) return { status: 201, json: { sha: 'tree2' } };
      if (method === 'POST' && path.endsWith('/git/commits')) return { status: 201, json: { sha: 'commit2' } };
      if (method === 'PATCH' && path.endsWith('/git/refs/heads/master')) {
        return { status: 200, json: { object: { sha: 'commit2' } } };
      }
      return { status: 404, json: { message: 'unexpected' } };
    },
  };

  const progress = [];
  const publisher = createMomentPublisher({ transport });
  const result = await publisher.publish(
    Object.assign({}, baseDraft, { images: [image] }),
    { onProgress: (item) => progress.push(item.step) },
  );

  assert.equal(result.id, '20261105123000');
  assert.equal(result.commitSha, 'commit2');
  const tree = calls.find((call) => call.method === 'POST' && call.path.endsWith('/git/trees'));
  assert.equal(tree.body.base_tree, 'tree1');
  assert.deepEqual(
    tree.body.tree.map((entry) => entry.path),
    ['src/data/moments/20261105123000.md', 'public/images/moments/20261105123000-1.png'],
  );
  assert.ok(progress.includes('done'));
});

test('createMomentPublisher appends a suffix when the timestamp exists', async () => {
  const transport = {
    async request({ method, path, body }) {
      if (method === 'GET' && path.includes('/contents/')) {
        return { status: 200, json: [{ name: '20261105123000.md', type: 'file' }] };
      }
      if (method === 'GET' && path.endsWith('/git/ref/heads/master')) {
        return { status: 200, json: { object: { sha: 'head1' } } };
      }
      if (method === 'GET' && path.endsWith('/git/commits/head1')) {
        return { status: 200, json: { tree: { sha: 'tree1' } } };
      }
      if (method === 'POST') return { status: 201, json: { sha: 'sha' } };
      return { status: 200, json: {} };
    },
  };
  const publisher = createMomentPublisher({ transport });
  const result = await publisher.publish(baseDraft);
  assert.equal(result.id, '20261105123000-2');
});
