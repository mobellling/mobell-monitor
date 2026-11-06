'use strict';

const VERSION = '1.3.1';

const DEFAULTS = {
  version: VERSION,
  siteUrl: 'https://mobellling.github.io',
  vercountEndpoint: 'https://events.vercount.one/api/v2/log',
  updates: {
    repo: 'mobellling/mobell-monitor',
    checkInterval: 6 * 60 * 60 * 1000,
    dismissedKey: 'updateDismissed',
  },
  repo: {
    owner: 'mobellling',
    name: 'mobellling.github.io',
    branch: 'master',
  },
  commentsRepo: 'mobellling/mobellling.github.io',
  intervals: {
    counters: 90 * 1000,
    content: 10 * 60 * 1000,
    words: 24 * 60 * 60 * 1000,
    deployPoll: 20 * 1000,
    deployTimeout: 10 * 60 * 1000,
  },
  limits: {
    concurrency: 3,
    requestGapMs: 120,
    maxBlogPages: 10,
    maxCommentPages: 3,
  },
  publish: {
    owner: 'mobellling',
    repo: 'mobellling.github.io',
    branch: 'master',
    author: 'Mobell',
    defaultCategory: 'Other',
    postDir: 'src/data/post',
    uploadDir: 'src/assets/images/uploads',
    maxCoverBytes: 5 * 1024 * 1024,
  },
  moments: {
    owner: 'mobellling',
    repo: 'mobellling.github.io',
    branch: 'master',
    dir: 'src/data/moments',
    imageDir: 'public/images/moments',
    maxText: 2000,
    maxImages: 6,
    maxImageBytes: 5 * 1024 * 1024,
  },
};

module.exports = { VERSION, DEFAULTS };
