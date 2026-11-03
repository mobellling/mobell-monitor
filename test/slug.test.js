'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { slugify, normalizeTerm, uniqueSlug } = require('../core/slug');

test('slugify matches the blog permalink rules', () => {
  assert.equal(slugify('如何搭建网站'), 'ru2-he2-da1-jian4-wang3-zhan4');
  assert.equal(slugify('潮汐_潭水'), 'chao2-xi1-tan2-shui3');
  assert.equal(slugify('Linux'), 'linux');
  assert.equal(slugify('2026级高等数学(上)期中考试试题讲解 Ⅱ'), '2026-ji2-gao1-deng3-shu4-xue2-shang4-qi1-zhong1-kao3-shi4-shi4-ti2-jiang3-jie3');
});

test('slugify strips unsafe characters and caps length', () => {
  assert.equal(slugify('Hello,  World!'), 'hello-world');
  assert.ok(slugify('a'.repeat(120)).length <= 80);
});

test('normalizeTerm converts giscus pathnames to slugs', () => {
  assert.equal(normalizeTerm('/linux/'), 'linux');
  assert.equal(normalizeTerm('mat2/'), 'mat2');
});

test('uniqueSlug appends a suffix when taken', () => {
  assert.equal(uniqueSlug('hello', ['hello']), 'hello-2');
  assert.equal(uniqueSlug('hello', ['hello', 'hello-2']), 'hello-3');
});
