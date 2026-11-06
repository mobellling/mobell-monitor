'use strict';

const {
  formatNumber, formatDate, relativeTime, escapeHtml, truncate, sleep,
} = require('../core/util');
const { DEFAULTS, VERSION } = require('../core/config');
const { slugify } = require('../core/slug');
const sources = require('../core/sources');
const { createPublisher, waitForDeploy } = require('../core/publish');
const { createMomentPublisher, waitForMomentDeploy } = require('../core/moments');
const { renderMarkdown, draftStats } = require('../core/markdown');
const { checkForUpdate } = require('../core/updates');
const { createPlatform } = require('./platform');
const YAML = require('yaml');

const platform = createPlatform();
const githubApi = (path) => platform.github.request({ method: 'GET', path });

async function githubText(url) {
  const parsed = new URL(url, DEFAULTS.siteUrl);
  if (parsed.origin !== 'https://api.github.com') return platform.httpText(url);
  const path = `${parsed.pathname}${parsed.search}`;
  const response = await platform.github.request({ method: 'GET', path });
  if (response.status === 404) throw new Error(`HTTP 404: ${url}`);
  if (response.status < 200 || response.status >= 300) {
    const message = response.json && response.json.message ? `: ${response.json.message}` : '';
    throw new Error(`HTTP ${response.status}${message}`);
  }
  return JSON.stringify(response.json == null ? {} : response.json);
}

const appRoot = () => document.getElementById('app');

const SETTINGS_DEFAULT = {
  autoRefresh: true,
  countersSec: 90,
  contentMin: 10,
  notifications: true,
  alwaysOnTop: false,
  miniOnStart: false,
};

const state = {
  tab: 'overview',
  settings: Object.assign({}, SETTINGS_DEFAULT),
  snapshot: null,
  loading: { counters: false, content: false, publish: false },
  health: { counters: null, content: null, comments: null, commit: null },
  updates: { checking: false, info: null, error: null, dismissed: null, checkedAt: 0 },
  publish: {
    draft: freshDraft(),
    cover: null,
    progress: [],
    result: null,
    error: null,
    deploying: false,
    deployAttempts: 0,
    deployResult: null,
    slugTouched: false,
    cancelDeploy: false,
  },
  moments: {
    draft: freshMomentDraft(),
    images: [],
    progress: [],
    result: null,
    error: null,
    deploying: false,
    deployAttempts: 0,
    deployResult: null,
    cancelDeploy: false,
    saving: false,
  },
  tokenPresent: false,
  tokenLogin: '',
  sort: 'date',
  toastTimer: null,
  mini: platform.isMini,
  relativeTimer: null,
  timers: [],
};

function freshDraft() {
  return {
    title: '',
    excerpt: '',
    category: DEFAULTS.publish.defaultCategory,
    tags: '',
    author: DEFAULTS.publish.author,
    publishDate: toLocalInput(new Date()),
    coverUrl: '',
    imageAlt: '',
    body: '',
    draft: false,
    slugOverride: '',
  };
}

function freshMomentDraft() {
  return { text: '', date: toLocalInput(new Date()) };
}

function toLocalInput(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function charLength(value) {
  return Array.from(String(value == null ? '' : value)).length;
}

function ensureSnapshot() {
  if (!state.snapshot) {
    state.snapshot = {
      site: { pv: 0, uv: 0 },
      posts: [],
      totals: { posts: 0, comments: 0, words: 0 },
      latestCommit: null,
      savedAt: 0,
      updatedAt: 0,
    };
  }
  return state.snapshot;
}

function contentIntervalMs() {
  return Math.max(1, Number(state.settings.contentMin) || 10) * 60 * 1000;
}

function countersIntervalMs() {
  return Math.max(30, Number(state.settings.countersSec) || 90) * 1000;
}

function isStale() {
  if (!state.snapshot || !state.snapshot.updatedAt) return true;
  return Date.now() - state.snapshot.updatedAt > contentIntervalMs() * 2;
}

function isMobile() {
  return platform.kind === 'android' || platform.kind === 'ios';
}

function isBrowserPreview() {
  return platform.kind === 'browser';
}

function canPublishNow() {
  return !isBrowserPreview() && (!isMobile() || Boolean(state.tokenPresent));
}

function canMomentsNow() {
  return !isBrowserPreview() && Boolean(state.tokenPresent);
}

function updateVisible() {
  return Boolean(state.updates.info)
    && state.updates.dismissed !== state.updates.info.version;
}

function saveSnapshot() {
  if (!state.snapshot) return;
  state.snapshot.savedAt = Date.now();
  platform.storage.set('snapshot', state.snapshot).catch(() => {});
}

async function init() {
  await loadSettings();
  applyWindowPrefs();
  const [cached, draft, momentDraft, dismissed] = await Promise.all([
    platform.storage.get('snapshot', null).catch(() => null),
    platform.storage.get('publishDraft', null).catch(() => null),
    platform.storage.get('momentDraft', null).catch(() => null),
    platform.storage.get(DEFAULTS.updates.dismissedKey, null).catch(() => null),
  ]);
  if (cached && cached.posts) state.snapshot = cached;
  if (dismissed) state.updates.dismissed = String(dismissed);
  if (draft && typeof draft === 'object' && !state.mini) {
    state.publish.draft = Object.assign(freshDraft(), draft);
    state.publish.draft.publishDate = draft.publishDate || toLocalInput(new Date());
  }
  if (momentDraft && typeof momentDraft === 'object' && !state.mini) {
    state.moments.draft = Object.assign(freshMomentDraft(), {
      text: String(momentDraft.text || ''),
      date: momentDraft.date || toLocalInput(new Date()),
    });
  }
  try {
    state.tokenPresent = await platform.token.has();
  } catch (error) {
    state.tokenPresent = false;
  }
  if (!canPublishNow() && state.tab === 'publish') state.tab = 'overview';
  if (!canMomentsNow() && state.tab === 'moments') state.tab = 'overview';
  bindEvents();
  render();
  startTicker();

  if (state.mini) {
    if (!state.snapshot || isStale()) {
      await Promise.all([refreshCounters(), refreshContent()]);
    }
    scheduleTimers();
    return;
  }

  scheduleTimers();
  setTimeout(() => {
    checkUpdates(false);
  }, 2500);
  const needsCounters = !state.snapshot || !state.snapshot.updatedAt
    || Date.now() - state.snapshot.updatedAt > countersIntervalMs();
  const needsContent = !state.snapshot || isStale() || !state.snapshot.posts.length;
  if (needsContent) {
    await refreshContent();
    await refreshCounters();
  } else if (needsCounters) {
    await refreshCounters();
    if (!state.snapshot.posts.length) await refreshContent();
  }
  if (state.settings.miniOnStart && platform.kind === 'windows') {
    platform.invokeDesktop('mini-open');
  }
}

async function loadSettings() {
  try {
    const saved = await platform.settingsStore.get('config', {});
    state.settings = Object.assign({}, SETTINGS_DEFAULT, saved || {});
  } catch (error) {
    state.settings = Object.assign({}, SETTINGS_DEFAULT);
  }
}

function applyWindowPrefs() {
  if (platform.kind === 'windows') {
    platform.invokeDesktop('set-always-on-top', Boolean(state.settings.alwaysOnTop));
  }
}

function scheduleTimers() {
  state.timers.forEach((timer) => clearInterval(timer));
  state.timers = [];
  if (!state.settings.autoRefresh) return;
  state.timers.push(setInterval(() => {
    if (document.visibilityState === 'visible') refreshCounters();
  }, countersIntervalMs()));
  state.timers.push(setInterval(() => {
    if (document.visibilityState === 'visible') refreshContent();
  }, contentIntervalMs()));
  state.timers.push(setInterval(() => {
    checkUpdates(false);
  }, DEFAULTS.updates.checkInterval));
}

async function refreshCounters() {
  if (state.loading.counters) return;
  state.loading.counters = true;
  renderStatusOnly();
  try {
    const snapshot = ensureSnapshot();
    let site;
    try {
      site = await sources.fetchSiteCounts({
        httpText: platform.httpText,
        siteUrl: DEFAULTS.siteUrl,
        endpoint: DEFAULTS.vercountEndpoint,
      });
    } catch (error) {
      await sleep(1200);
      site = await sources.fetchSiteCounts({
        httpText: platform.httpText,
        siteUrl: DEFAULTS.siteUrl,
        endpoint: DEFAULTS.vercountEndpoint,
      });
    }
    snapshot.site = { pv: site.sitePv, uv: site.siteUv };
    if (snapshot.posts.length) {
      const posts = snapshot.posts.map((post) => ({ url: post.url, slug: post.slug }));
      const result = await sources.fetchPostViews({
        httpText: platform.httpText,
        endpoint: DEFAULTS.vercountEndpoint,
        posts,
        concurrency: DEFAULTS.limits.concurrency,
        gapMs: DEFAULTS.limits.requestGapMs,
      });
      if (result.errors.length) {
        await sleep(1500);
        const retryPosts = posts.filter((post) => result.errors.some((item) => item.slug === post.slug));
        try {
          const retry = await sources.fetchPostViews({
            httpText: platform.httpText,
            endpoint: DEFAULTS.vercountEndpoint,
            posts: retryPosts,
            concurrency: 1,
            gapMs: 300,
          });
          Object.assign(result.views, retry.views);
          result.errors = result.errors.filter((item) => retry.views[item.slug] === undefined);
        } catch (error) {
          // 保留第一次的错误
        }
      }
      for (const post of snapshot.posts) {
        if (result.views[post.slug] !== undefined) post.views = result.views[post.slug];
      }
      state.health.counters = result.errors.length
        ? { error: `有 ${result.errors.length} 篇文章的阅读量暂时取不到，已保留上次数据`, at: Date.now(), partial: true }
        : null;
    } else {
      state.health.counters = null;
    }
    snapshot.updatedAt = Date.now();
    saveSnapshot();
  } catch (error) {
    state.health.counters = { error: `访问量获取失败：${error.message || error}`, at: Date.now() };
  } finally {
    state.loading.counters = false;
    render();
  }
}

async function refreshContent() {
  if (state.loading.content) return;
  state.loading.content = true;
  state.health.content = null;
  state.health.comments = null;
  state.health.commit = null;
  renderStatusOnly();
  try {
    let posts;
    try {
      posts = await sources.discoverPosts({
        httpText: platform.httpText,
        siteUrl: DEFAULTS.siteUrl,
        maxPages: DEFAULTS.limits.maxBlogPages,
      });
    } catch (error) {
      posts = await sources.discoverPostsFromRss({
        httpText: platform.httpText,
        siteUrl: DEFAULTS.siteUrl,
      });
    }

    const details = await mapPosts(posts, async (post) => {
      const detail = await sources.fetchPostDetail({ httpText: platform.httpText, url: post.url });
      return { post, detail };
    });

    let commit = null;
    try {
      commit = await sources.fetchLatestCommit({
        httpText: platform.httpText,
        github: githubApi,
        repo: DEFAULTS.commentsRepo,
        siteUrl: DEFAULTS.siteUrl,
      });
    } catch (error) {
      state.health.commit = { error: `最近上传时间获取失败：${error.message}`, at: Date.now() };
    }

    let comments = null;
    try {
      comments = await sources.fetchComments({
        httpText: platform.httpText,
        github: githubApi,
        repo: DEFAULTS.commentsRepo,
        maxPages: DEFAULTS.limits.maxCommentPages,
      });
    } catch (error) {
      state.health.comments = { error: `评论数据获取失败：${error.message}`, at: Date.now(), partial: true };
    }

    const previous = ensureSnapshot();
    const oldPost = (slug) => previous.posts.find((item) => item.slug === slug);
    const commentCount = (slug) => {
      if (comments) return comments.byTerm[slug] || 0;
      const old = oldPost(slug);
      return old ? old.comments || 0 : 0;
    };

    const wordCache = (await platform.storage.get('words', { commit: '', items: {} }).catch(() => null)) || {};
    const cache = {
      commit: wordCache.commit || '',
      items: wordCache.items || {},
    };
    if (commit && cache.commit !== commit.sha) {
      cache.commit = commit.sha;
      cache.items = {};
    }

    const merged = [];
    details.forEach((entry, index) => {
      const post = posts[index];
      if (entry && entry.__error) {
        const old = oldPost(post.slug);
        merged.push({
          slug: post.slug,
          url: post.url,
          title: post.listTitle || post.slug,
          publishDate: post.publishDate || null,
          views: old ? old.views : 0,
          comments: commentCount(post.slug),
          words: null,
          error: String(entry.__error.message || entry.__error),
        });
        return;
      }
      const detail = entry.detail;
      let words = detail.words;
      let cjk = detail.cjk;
      let latin = detail.latin;
      const cached = cache.items[post.slug];
      if (cached && Date.now() - cached.ts < DEFAULTS.intervals.words) {
        words = cached.words;
        cjk = cached.cjk;
        latin = cached.latin;
      } else {
        cache.items[post.slug] = { words: detail.words, cjk: detail.cjk, latin: detail.latin, ts: Date.now() };
      }
      merged.push({
        slug: post.slug,
        url: post.url,
        title: detail.title || post.listTitle || post.slug,
        publishDate: detail.publishDate || post.publishDate || null,
        views: null,
        comments: commentCount(post.slug),
        words,
        cjk,
        latin,
      });
    });

    merged.forEach((post) => {
      const old = oldPost(post.slug);
      if (old && post.views === null) post.views = old.views;
    });
    merged.sort((a, b) => {
      const da = a.publishDate ? new Date(a.publishDate).getTime() : 0;
      const db = b.publishDate ? new Date(b.publishDate).getTime() : 0;
      return db - da;
    });

    const totals = {
      posts: merged.length,
      comments: merged.reduce((sum, post) => sum + (post.comments || 0), 0),
      words: merged.reduce((sum, post) => sum + (post.words || 0), 0),
    };

    previous.posts = merged;
    previous.totals = totals;
    if (commit) previous.latestCommit = commit;
    previous.updatedAt = Date.now();
    saveSnapshot();
    await platform.storage.set('words', { commit: cache.commit, items: cache.items }).catch(() => {});
    await platform.updateWidget({
      sitePv: previous.site ? previous.site.pv : null,
      siteUv: previous.site ? previous.site.uv : null,
      posts: totals.posts,
      comments: totals.comments,
      lastUpload: previous.latestCommit ? previous.latestCommit.updated : null,
    });
    if (!previous.site || !previous.site.uv) {
      try {
        const site = await sources.fetchSiteCounts({
          httpText: platform.httpText,
          siteUrl: DEFAULTS.siteUrl,
          endpoint: DEFAULTS.vercountEndpoint,
        });
        previous.site = { pv: site.sitePv, uv: site.siteUv };
      } catch (error) {
        // 站点计数稍后由计数器任务补齐
      }
    }
  } catch (error) {
    state.health.content = { error: error.message || String(error), at: Date.now() };
  } finally {
    state.loading.content = false;
    render();
  }
}

async function mapPosts(posts, worker) {
  const results = new Array(posts.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(DEFAULTS.limits.concurrency, posts.length || 1));
  const runners = Array.from({ length: count }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= posts.length) return;
      try {
        results[index] = await worker(posts[index], index);
      } catch (error) {
        results[index] = { __error: error };
      }
      await new Promise((resolve) => setTimeout(resolve, DEFAULTS.limits.requestGapMs));
    }
  });
  await Promise.all(runners);
  return results;
}

function render() {
  if (!appRoot()) return;
  document.body.classList.toggle('mini-mode', state.mini);
  appRoot().innerHTML = state.mini ? renderMini() : renderShell();
}

function renderStatusOnly() {
  const status = document.getElementById('sync-status');
  if (!status) return;
  status.innerHTML = renderStatusInner();
}

function healthErrors() {
  return [state.health.counters, state.health.content, state.health.comments, state.health.commit]
    .filter((item) => item && item.error);
}

function renderStatusInner() {
  if (state.loading.content || state.loading.counters) {
    return '<span class="dot busy"></span><span>正在同步…</span>';
  }
  const errors = [state.health.counters, state.health.content, state.health.comments, state.health.commit]
    .filter((item) => item && item.error);
  if (errors.length) {
    return `<span class="dot warn"></span><span title="${escapeHtml(errors[0].error)}">部分数据获取失败</span>`;
  }
  if (state.snapshot && state.snapshot.updatedAt) {
    return `<span class="dot ${isStale() ? 'warn' : 'ok'}"></span><span>更新于 ${escapeHtml(relativeTime(state.snapshot.updatedAt))}</span>`;
  }
  return '<span class="dot"></span><span>等待首次同步</span>';
}

function renderShell() {
  return `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="logo">M</div>
          <div>
            <h1>Mobell 博客监控</h1>
            <p class="muted">mobellling.github.io</p>
          </div>
        </div>
        <div class="topbar-right">
          <div id="sync-status" class="status">${renderStatusInner()}</div>
          <button class="btn ghost" data-action="refresh" ${state.loading.counters || state.loading.content ? 'disabled' : ''}>刷新</button>
          ${platform.kind === 'windows' ? '<button class="btn ghost" data-action="toggle-mini">悬浮窗</button>' : ''}
          ${platform.demo ? '<a class="btn ghost" href="https://github.com/mobellling/mobell-monitor/releases" data-open>下载客户端</a>' : ''}
        </div>
      </header>
      <nav class="tabs">
        <button class="tab ${state.tab === 'overview' ? 'active' : ''}" data-tab="overview">概览</button>
        ${canPublishNow() ? `<button class="tab ${state.tab === 'publish' ? 'active' : ''}" data-tab="publish">发布</button>` : ''}
        ${canMomentsNow() ? `<button class="tab ${state.tab === 'moments' ? 'active' : ''}" data-tab="moments">动态</button>` : ''}
        <button class="tab ${state.tab === 'settings' ? 'active' : ''}" data-tab="settings">设置</button>
      </nav>
      <main class="content">
        ${state.tab === 'overview' ? renderOverview() : ''}
        ${state.tab === 'publish' && canPublishNow() ? renderPublish() : ''}
        ${state.tab === 'moments' && canMomentsNow() ? renderMoments() : ''}
        ${state.tab === 'settings' ? renderSettings() : ''}
      </main>
      <footer class="footer">
        <span>数据来源：Vercount · GitHub Discussions · 文章页 / RSS · GitHub Commits</span>
        <span>v${VERSION}${platform.demo ? ' · 浏览器预览' : ''}</span>
      </footer>
      ${updateVisible() ? renderUpdateModal() : ''}
      <div id="toast" class="toast" hidden></div>
    </div>
  `;
}

function renderUpdateModal() {
  const info = state.updates.info;
  if (!info) return '';
  const hasAsset = Boolean(info.hasAsset);
  return `
    <div class="modal-backdrop" data-action="update-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <div class="modal-head">
          <h2 id="update-title">发现新版本 v${escapeHtml(info.version)}</h2>
          <button class="icon-btn" data-action="update-dismiss" title="关闭">×</button>
        </div>
        <p class="muted small">当前版本 v${VERSION}，建议更新后使用。</p>
        <div class="release-notes">${escapeHtml(info.notes || '本次更新包含问题修复与体验改进。')}</div>
        <div class="hint">${hasAsset ? '下载后覆盖安装即可保留现有设置。' : '该版本暂未上传安装包，可前往发布页查看。'}</div>
        <div class="modal-actions">
          <button class="btn primary" data-action="update-download">${hasAsset ? '前往下载' : '打开发布页'}</button>
          <button class="btn ghost" data-action="update-dismiss">稍后提醒</button>
        </div>
      </div>
    </div>
  `;
}


function renderOverview() {
  const snapshot = state.snapshot;
  if (!snapshot || (!snapshot.updatedAt && !snapshot.posts.length)) {
    return `
      <section class="card empty-state">
        <div class="spinner"></div>
        <h2>正在读取博客数据…</h2>
        <p class="muted">首次同步需要抓取 10 篇文章，大约 10–20 秒。</p>
      </section>
    `;
  }
  const commit = snapshot.latestCommit;
  const stale = isStale();
  return `
    ${stale ? '<div class="notice warn">数据可能已过期，点击右上角“刷新”更新。</div>' : ''}
    ${platform.demo ? '<div class="notice">网页版为只读预览：可查看访问量、文章、评论与字数；发布和动态请使用桌面版或移动端。GitHub 匿名接口有频率限制，失败时会保留上次数据。</div>' : ''}
    <section class="hero card">
      <div class="hero-main">
        <div class="metric-label">站点总访问</div>
        <div class="metric-value">${formatNumber(snapshot.site.pv)}</div>
        <div class="metric-sub">独立访客 ${formatNumber(snapshot.site.uv)}</div>
      </div>
      <div class="hero-grid">
        <div class="stat"><span>文章</span><strong>${formatNumber(snapshot.totals.posts)}</strong></div>
        <div class="stat"><span>评论</span><strong>${formatNumber(snapshot.totals.comments)}</strong></div>
        <div class="stat"><span>总字数</span><strong>${formatNumber(snapshot.totals.words)}</strong></div>
        <div class="stat"><span>距上次上传</span><strong data-relative="${commit && commit.updated ? new Date(commit.updated).getTime() : ''}">${commit && commit.updated ? escapeHtml(relativeTime(commit.updated)) : '—'}</strong></div>
      </div>
    </section>

    <section class="panel-grid">
      <div class="card">
        <div class="card-title">最近上传</div>
        ${
          commit
            ? `<div class="commit-title">${escapeHtml(commit.title || '（无标题提交）')}</div>
               <div class="muted small">${escapeHtml(formatDate(commit.updated))} · <a href="${escapeHtml(commit.url || DEFAULTS.siteUrl)}" data-open>${escapeHtml(commit.sha ? commit.sha.slice(0, 7) : '构建记录')}</a></div>`
            : '<div class="muted">暂无提交信息</div>'
        }
      </div>
      <div class="card">
        <div class="card-title">数据源</div>
        <ul class="source-list">
          <li><span>访问量 / 访客</span><span class="${state.health.counters ? (state.health.counters.partial ? 'warn' : 'bad') : 'good'}">${state.health.counters ? (state.health.counters.partial ? '部分异常' : '异常') : '正常'}</span></li>
          <li><span>文章与字数</span><span class="${state.health.content ? 'bad' : 'good'}">${state.health.content ? '异常' : '正常'}</span></li>
          <li><span>评论（GitHub）</span><span class="${state.health.comments ? 'bad' : 'good'}">${state.health.comments ? '异常' : '正常'}</span></li>
        </ul>
        ${healthErrors().map((item) => `<div class="notice warn small">${escapeHtml(item.error)}</div>`).join('')}
      </div>
    </section>

    <section class="card posts-card">
      <div class="card-title-row">
        <div class="card-title">文章数据</div>
        <div class="muted small">共 ${formatNumber(snapshot.posts.length)} 篇</div>
      </div>
      <div class="table-wrap">
        <table class="posts-table">
          <thead>
            <tr>
              <th>文章</th>
              <th class="num ${state.sort === 'views' ? 'sorted' : ''}" data-action="sort" data-sort="views">阅读</th>
              <th class="num ${state.sort === 'comments' ? 'sorted' : ''}" data-action="sort" data-sort="comments">评论</th>
              <th class="num ${state.sort === 'words' ? 'sorted' : ''}" data-action="sort" data-sort="words">字数</th>
              <th class="num ${state.sort === 'date' ? 'sorted' : ''}" data-action="sort" data-sort="date">发布</th>
            </tr>
          </thead>
          <tbody>
            ${sortedPosts().map(renderPostRow).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function sortedPosts() {
  const posts = (state.snapshot && state.snapshot.posts ? state.snapshot.posts.slice() : []);
  const value = (post) => {
    if (state.sort === 'views') return post.views || 0;
    if (state.sort === 'comments') return post.comments || 0;
    if (state.sort === 'words') return post.words || 0;
    return post.publishDate ? new Date(post.publishDate).getTime() : 0;
  };
  return posts.sort((a, b) => value(b) - value(a));
}

function renderPostRow(post) {
  const date = post.publishDate ? formatDate(post.publishDate).slice(0, 10) : '—';
  return `
    <tr>
      <td>
        <a href="${escapeHtml(post.url)}" data-open class="post-link">${escapeHtml(post.title || post.slug)}</a>
        ${post.error ? `<div class="bad small">${escapeHtml(post.error)}</div>` : ''}
      </td>
      <td class="num">${post.views === null || post.views === undefined ? '—' : formatNumber(post.views)}</td>
      <td class="num">${formatNumber(post.comments)}</td>
      <td class="num">${post.words === null || post.words === undefined ? '—' : formatNumber(post.words)}</td>
      <td class="num muted">${escapeHtml(date)}</td>
    </tr>
  `;
}

function renderPublish() {
  const draft = state.publish.draft;
  const slug = currentSlug();
  const stats = draftStats(draft.body);
  const cover = state.publish.cover;
  const error = state.publish.error;
  return `
    <section class="card publish-card">
      <div class="card-title-row">
        <div>
          <div class="card-title">发布新文章</div>
          <div class="muted small">直接提交到 GitHub 仓库 master 分支，推送后自动构建部署。</div>
        </div>
        <div class="row-actions">
          <input type="file" id="import-file" accept=".md,.mdx,text/markdown" class="file-picker-input" tabindex="-1" aria-hidden="true">
          <button class="btn ghost" data-action="import-md" type="button">导入 .md</button>
        </div>
      </div>
      ${!state.tokenPresent ? '<div class="notice warn">尚未配置 GitHub Token，暂时无法发布。<button class="link-btn" data-action="goto-settings">去设置</button></div>' : ''}
      <form id="publish-form" class="form" autocomplete="off" onsubmit="return false">
        <div class="field">
          <label>标题 <em>*</em></label>
          <input data-field="title" value="${escapeHtml(draft.title)}" placeholder="例如：我的第一篇博客" maxlength="120">
          ${error && error.fields && error.fields.title ? `<div class="field-error">${escapeHtml(error.fields.title)}</div>` : ''}
        </div>
        <div class="field">
          <label>URL</label>
          <div class="slug-row">
            <span class="slug-prefix">/${escapeHtml(slug)}/</span>
            <input data-field="slugOverride" value="${escapeHtml(draft.slugOverride)}" placeholder="自定义 slug（可选）">
          </div>
          <div class="hint">最终地址：<span id="slug-preview">/${escapeHtml(slug)}/</span>；留空时由标题自动生成。</div>
          ${error && error.fields && error.fields.slug ? `<div class="field-error">${escapeHtml(error.fields.slug)}</div>` : ''}
        </div>
        <div class="field">
          <label>摘要</label>
          <textarea data-field="excerpt" rows="2" maxlength="155" placeholder="显示在列表与社交卡片中的简短摘要">${escapeHtml(draft.excerpt)}</textarea>
          <div class="hint"><span id="excerpt-count">${charLength(draft.excerpt)}</span>/155</div>
          ${error && error.fields && error.fields.excerpt ? `<div class="field-error">${escapeHtml(error.fields.excerpt)}</div>` : ''}
        </div>
        <div class="field-row">
          <div class="field">
            <label>分类</label>
            <input data-field="category" value="${escapeHtml(draft.category)}" placeholder="Other">
          </div>
          <div class="field">
            <label>作者</label>
            <input data-field="author" value="${escapeHtml(draft.author)}" placeholder="Mobell">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>标签</label>
            <input data-field="tags" value="${escapeHtml(draft.tags)}" placeholder="用逗号分隔，例如：Astro, 博客">
          </div>
          <div class="field">
            <label>发布日期</label>
            <input type="datetime-local" data-field="publishDate" value="${escapeHtml(draft.publishDate)}">
          </div>
        </div>
        <div class="field">
          <label>封面</label>
          <div class="cover-row">
            ${cover ? `<img class="cover-thumb" alt="封面预览" src="data:${escapeHtml(cover.mime)};base64,${cover.base64}">` : '<div class="cover-thumb placeholder">无</div>'}
            <div class="cover-actions">
              <input type="file" id="cover-file" accept="image/jpeg,image/png,image/webp" class="file-picker-input" tabindex="-1" aria-hidden="true">
              <button class="btn ghost" type="button" data-action="pick-cover">选择图片</button>
              ${cover ? '<button class="btn ghost" type="button" data-action="clear-cover">移除</button>' : ''}
              <input data-field="coverUrl" value="${escapeHtml(draft.coverUrl)}" placeholder="或填写图片 URL">
              <div class="hint">支持 JPG/PNG/WebP，不超过 5MB；上传后自动转为 WebP（保留透明背景）。</div>
              ${error && error.fields && error.fields.cover ? `<div class="field-error">${escapeHtml(error.fields.cover)}</div>` : ''}
            </div>
          </div>
        </div>
        <div class="field">
          <label>正文 <em>*</em></label>
          <textarea data-field="body" class="body-input" rows="18" placeholder="支持 Markdown…">${escapeHtml(draft.body)}</textarea>
          <div class="hint" id="draft-stats">${stats.words} 字 · 约 ${stats.readMinutes} 分钟阅读</div>
          ${error && error.fields && error.fields.body ? `<div class="field-error">${escapeHtml(error.fields.body)}</div>` : ''}
          <details class="preview-box">
            <summary>正文预览</summary>
            <div id="body-preview" class="markdown-preview">${renderMarkdown(draft.body)}</div>
          </details>
        </div>
        <label class="check">
          <input type="checkbox" data-field="draft" ${draft.draft ? 'checked' : ''}>
          保存为草稿（不在博客列表中显示）
        </label>
        <div class="form-actions">
          <button class="btn primary" type="button" data-action="publish" ${state.loading.publish ? 'disabled' : ''}>${state.loading.publish ? '正在发布…' : '发布到 GitHub'}</button>
          <button class="btn ghost" type="button" data-action="clear-draft">清空</button>
          <span class="muted small">提交信息：post: 添加《标题》</span>
        </div>
      </form>
      <div id="publish-live">${renderPublishLive()}</div>
    </section>
  `;
}

function renderPublishLive() {
  const publish = state.publish;
  const parts = [];
  if (publish.progress.length) {
    parts.push(`<div class="progress-list">${publish.progress.map((item) => `<div class="progress-item"><span class="tick">✓</span>${escapeHtml(item.message || item.step)}</div>`).join('')}</div>`);
  }
  if (publish.error) {
    const error = publish.error;
    parts.push(`
      <div class="notice bad">
        <strong>发布失败：</strong>${escapeHtml(error.message || error.code || '未知错误')}
        ${error.suggestedSlug ? `<button class="link-btn" data-action="use-suggested" data-slug="${escapeHtml(error.suggestedSlug)}">改用 ${escapeHtml(error.suggestedSlug)}</button>` : ''}
        ${error.fields ? `<ul class="field-list">${Object.entries(error.fields).map(([key, value]) => `<li>${escapeHtml(key)}：${escapeHtml(value)}</li>`).join('')}</ul>` : ''}
      </div>
    `);
  }
  if (publish.result) {
    const result = publish.result;
    let deployText = '';
    if (publish.deploying) deployText = `正在等待部署…（已检测 ${publish.deployAttempts} 次，通常 1–3 分钟）`;
    else if (publish.deployResult && publish.deployResult.deployed) deployText = '博客已上线';
    else if (publish.deployResult && publish.deployResult.timeout) deployText = '还未检测到上线，GitHub Actions 可能仍在构建，稍后刷新即可';
    else if (publish.deployResult && publish.deployResult.cancelled) deployText = '已停止等待部署';
    parts.push(`
      <div class="notice ok">
        <div><strong>已提交：</strong>${escapeHtml(result.title)} → <a href="${escapeHtml(result.url)}" data-open>/${escapeHtml(result.slug)}/</a></div>
        <div class="small muted">commit <a href="${escapeHtml(result.commitUrl)}" data-open>${escapeHtml((result.commitSha || '').slice(0, 7))}</a> · ${escapeHtml(deployText)}</div>
        <div class="row-actions">
          <button class="btn ghost small" data-action="open-post" data-url="${escapeHtml(result.url)}">打开文章</button>
          ${publish.deploying ? '<button class="btn ghost small" data-action="cancel-deploy">停止等待</button>' : ''}
        </div>
      </div>
    `);
  }
  return parts.join('');
}

function renderMoments() {
  const draft = state.moments.draft;
  const images = state.moments.images;
  const error = state.moments.error;
  return `
    <section class="card publish-card">
      <div class="card-title-row">
        <div>
          <div class="card-title">发动态</div>
          <div class="muted small">发布到博客的 /moments/ 页面，支持文字和图片；提交后自动构建部署。</div>
        </div>
        <div class="row-actions">
          <input type="file" id="moment-images" accept="image/jpeg,image/png,image/webp" multiple class="file-picker-input" tabindex="-1" aria-hidden="true">
          <button class="btn ghost" data-action="pick-moment-images" type="button">选择图片</button>
        </div>
      </div>
      <form id="moment-form" class="form" autocomplete="off" onsubmit="return false">
        <div class="field">
          <label>内容 <em>*</em></label>
          <textarea data-moment-field="text" rows="6" maxlength="${DEFAULTS.moments.maxText}" placeholder="今天发生了什么，或者随便说点什么…">${escapeHtml(draft.text)}</textarea>
          <div class="hint"><span id="moment-text-count">${charLength(draft.text)}</span>/${DEFAULTS.moments.maxText}</div>
          ${error && error.fields && error.fields.text ? `<div class="field-error">${escapeHtml(error.fields.text)}</div>` : ''}
        </div>
        <div class="field">
          <label>时间</label>
          <input type="datetime-local" data-moment-field="date" value="${escapeHtml(draft.date)}">
          ${error && error.fields && error.fields.date ? `<div class="field-error">${escapeHtml(error.fields.date)}</div>` : ''}
        </div>
        <div class="field">
          <label>图片（最多 ${DEFAULTS.moments.maxImages} 张，每张不超过 5MB，自动转为 WebP）</label>
          ${
            images.length
              ? `<div class="moment-grid">${images.map((image, index) => `
                  <div class="moment-thumb">
                    <img alt="动态图片 ${index + 1}" src="data:${escapeHtml(image.mime)};base64,${image.base64}">
                    <button class="thumb-remove" data-action="remove-moment-image" data-index="${index}" type="button" title="移除">×</button>
                  </div>`).join('')}</div>`
              : '<div class="image-empty">还没有选择图片</div>'
          }
          ${error && error.fields && error.fields.images ? `<div class="field-error">${escapeHtml(error.fields.images)}</div>` : ''}
        </div>
        <div class="form-actions">
          <button class="btn primary" type="button" data-action="publish-moment" ${state.moments.saving ? 'disabled' : ''}>${state.moments.saving ? '正在发布…' : '发布动态'}</button>
          <button class="btn ghost" type="button" data-action="clear-moment">清空</button>
          <a class="link-btn" href="${escapeHtml(DEFAULTS.siteUrl)}/moments/" data-open>打开动态页</a>
        </div>
      </form>
      <div id="moment-live">${renderMomentLive()}</div>
    </section>
  `;
}

function renderMomentLive() {
  const moment = state.moments;
  const parts = [];
  if (moment.progress.length) {
    parts.push(`<div class="progress-list">${moment.progress.map((item) => `<div class="progress-item"><span class="tick">✓</span>${escapeHtml(item.message || item.step)}</div>`).join('')}</div>`);
  }
  if (moment.error) {
    parts.push(`
      <div class="notice bad">
        <strong>发布失败：</strong>${escapeHtml(moment.error.message || moment.error.code || '未知错误')}
        ${moment.error.fields ? `<ul class="field-list">${Object.entries(moment.error.fields).map(([key, value]) => `<li>${escapeHtml(key)}：${escapeHtml(value)}</li>`).join('')}</ul>` : ''}
      </div>
    `);
  }
  if (moment.result) {
    const result = moment.result;
    let deployText = '';
    if (moment.deploying) deployText = `正在等待部署…（已检测 ${moment.deployAttempts} 次，通常 1–3 分钟）`;
    else if (moment.deployResult && moment.deployResult.deployed) deployText = '动态页已上线';
    else if (moment.deployResult && moment.deployResult.timeout) deployText = '还未检测到上线，GitHub Actions 可能仍在构建，稍后刷新即可';
    else if (moment.deployResult && moment.deployResult.cancelled) deployText = '已停止等待部署';
    parts.push(`
      <div class="notice ok">
        <div><strong>已提交：</strong>${escapeHtml(formatDate(result.date))} → <a href="${escapeHtml(result.url)}" data-open>/moments/${escapeHtml(result.id)}/</a></div>
        <div class="small muted">commit <a href="${escapeHtml(result.commitUrl)}" data-open>${escapeHtml((result.commitSha || '').slice(0, 7))}</a> · ${escapeHtml(deployText)}</div>
        <div class="row-actions">
          <button class="btn ghost small" data-action="open-moment" data-url="${escapeHtml(result.url)}">打开动态</button>
          ${moment.deploying ? '<button class="btn ghost small" data-action="cancel-moment-deploy">停止等待</button>' : ''}
        </div>
      </div>
    `);
  }
  return parts.join('');
}

function renderSettings() {
  const settings = state.settings;
  return `
    <section class="card">
      <div class="card-title">GitHub 发布</div>
      <div class="muted small">仓库 ${escapeHtml(DEFAULTS.publish.owner)}/${escapeHtml(DEFAULTS.publish.repo)} · 分支 ${escapeHtml(DEFAULTS.publish.branch)}</div>
      ${isBrowserPreview() ? `
        <p class="muted small">网页版为只读预览，不支持保存 Token、发布文章或发动态。需要发布请使用 Windows / Android / iOS 客户端。</p>
        <p class="small"><a class="link-btn" href="https://github.com/mobellling/mobell-monitor/releases" data-open>前往下载客户端</a></p>
      ` : `
      <div class="token-box">
        <div class="token-status">
          <span class="dot ${state.tokenPresent ? 'ok' : 'warn'}"></span>
          ${state.tokenPresent ? `Token 已保存${state.tokenLogin ? `（@${escapeHtml(state.tokenLogin)}）` : ''}` : '尚未保存 Token'}
        </div>
        <div class="field-row">
          <input id="token-input" type="password" placeholder="粘贴 fine-grained PAT（Contents: Read and write）" autocomplete="off">
          <button class="btn" data-action="token-save" type="button">保存</button>
        </div>
        <div class="row-actions">
          <button class="btn ghost small" data-action="token-test" type="button">校验</button>
          <button class="btn ghost small" data-action="token-clear" type="button">清除</button>
          <a class="link-btn" href="https://github.com/settings/personal-access-tokens/new" data-open>创建 Token</a>
        </div>
        <p class="hint">Token 只保存在本机（Windows 使用系统加密，安卓使用 Keystore，iOS 使用钥匙串），不会写入网页或日志；仅需该仓库 Contents 的读写权限。${isMobile() ? '安卓 / iOS 在未保存 Token 时不会显示发布页。' : ''}</p>
      </div>
      `}
    </section>

    <section class="card">
      <div class="card-title">刷新</div>
      <label class="check"><input type="checkbox" data-setting="autoRefresh" ${settings.autoRefresh ? 'checked' : ''}> 自动刷新</label>
      <div class="field-row">
        <div class="field">
          <label>访问量刷新间隔（秒）</label>
          <input type="number" min="30" max="3600" data-setting="countersSec" value="${Number(settings.countersSec)}">
        </div>
        <div class="field">
          <label>文章/评论刷新间隔（分钟）</label>
          <input type="number" min="1" max="180" data-setting="contentMin" value="${Number(settings.contentMin)}">
        </div>
      </div>
      <div class="form-actions">
        <button class="btn primary" data-action="settings-save" type="button">保存设置</button>
        <button class="btn ghost" data-action="reset-data" type="button">清除缓存数据</button>
      </div>
    </section>

    ${platform.kind === 'windows' ? `
      <section class="card">
        <div class="card-title">桌面</div>
        <label class="check"><input type="checkbox" data-setting="alwaysOnTop" ${settings.alwaysOnTop ? 'checked' : ''}> 主窗口置顶</label>
        <label class="check"><input type="checkbox" data-setting="miniOnStart" ${settings.miniOnStart ? 'checked' : ''}> 启动时显示悬浮窗</label>
        <div class="row-actions">
          <button class="btn ghost" data-action="toggle-mini" type="button">打开 / 关闭悬浮窗</button>
        </div>
      </section>
    ` : ''}

    <section class="card">
      <div class="card-title">版本与更新</div>
      <div class="row-actions">
        <button class="btn ghost" data-action="check-update" type="button" ${state.updates.checking ? 'disabled' : ''}>${state.updates.checking ? '正在检查…' : '检查更新'}</button>
        <span class="muted small">当前版本 v${VERSION} · 更新仓库 ${escapeHtml(DEFAULTS.updates.repo)}</span>
      </div>
      ${state.updates.info ? `
        <div class="notice ok small">
          发现新版本 v${escapeHtml(state.updates.info.version)}
          <button class="link-btn" data-action="update-download">前往下载</button>
        </div>
      ` : state.updates.error ? `<div class="notice warn small">${escapeHtml(state.updates.error)}</div>` : state.updates.checkedAt ? '<div class="muted small">已是最新版本</div>' : ''}
    </section>

    <section class="card">
      <div class="card-title">通知</div>
      <label class="check"><input type="checkbox" data-setting="notifications" ${settings.notifications ? 'checked' : ''}> 发布上线后发送系统通知</label>
    </section>

    <section class="card about">
      <div class="card-title">关于</div>
      <p class="muted small">Mobell 博客监控 v${VERSION}。数据来自公开接口，不修改博客内容；发布功能通过你的 GitHub Token 提交到仓库。</p>
      <p class="muted small">构建：${escapeHtml(platform.kind)} · 共享核心 v${VERSION}</p>
    </section>
  `;
}

function renderMini() {
  const snapshot = state.snapshot;
  const site = snapshot ? snapshot.site : { pv: 0, uv: 0 };
  const totals = snapshot ? snapshot.totals : { posts: 0, comments: 0, words: 0 };
  const commit = snapshot ? snapshot.latestCommit : null;
  return `
    <div class="mini-card">
      <div class="mini-head">
        <span class="mini-title"><span class="dot ${isStale() ? 'warn' : 'ok'}"></span>Mobell 博客</span>
        <span class="mini-actions">
          <button class="icon-btn" data-action="mini-refresh" title="刷新">↻</button>
          <button class="icon-btn" data-action="mini-expand" title="打开主界面">⤢</button>
          <button class="icon-btn" data-action="mini-close" title="关闭">×</button>
        </span>
      </div>
      <div class="mini-main">
        <div class="mini-pv">${formatNumber(site.pv)}</div>
        <div class="mini-uv">独立访客 ${formatNumber(site.uv)}</div>
      </div>
      <div class="mini-grid">
        <div><strong>${formatNumber(totals.posts)}</strong><span>文章</span></div>
        <div><strong>${formatNumber(totals.comments)}</strong><span>评论</span></div>
        <div><strong>${formatNumber(totals.words)}</strong><span>字数</span></div>
      </div>
      <div class="mini-foot">${commit && commit.updated ? `上次上传 ${escapeHtml(relativeTime(commit.updated))}` : '等待同步…'}</div>
    </div>
  `;
}

function currentSlug() {
  const draft = state.publish.draft;
  return (draft.slugOverride ? slugify(draft.slugOverride) : slugify(draft.title)) || 'your-post';
}

function bindEvents() {
  const root = appRoot();
  root.addEventListener('click', handleClick);
  root.addEventListener('input', handleInput);
  root.addEventListener('change', handleChange);
}

function openFilePicker(input) {
  if (!input) return;
  input.value = '';
  // Android WebView sometimes ignores .click() on display:none file inputs.
  // showPicker() is the modern path; fall back to click() for older WebViews.
  if (typeof input.showPicker === 'function') {
    try {
      input.showPicker();
      return;
    } catch (error) {
      // NotAllowedError / SecurityError -> use the legacy click path.
    }
  }
  input.click();
}

async function handleClick(event) {
  const openLink = event.target.closest('[data-open]');
  if (openLink) {
    event.preventDefault();
    if (openLink.getAttribute('href')) platform.openExternal(openLink.getAttribute('href'));
    return;
  }
  const target = event.target.closest('[data-action], [data-tab]');
  if (!target) return;
  if (target.dataset.tab) {
    if (target.dataset.tab === 'moments' && !canMomentsNow()) {
      showToast('请先在设置中保存 GitHub Token', 'err');
      return;
    }
    state.tab = target.dataset.tab;
    render();
    return;
  }
  const action = target.dataset.action;
  if (!action) return;
  event.preventDefault();

  if (action === 'refresh') {
    await refreshContent();
    await refreshCounters();
    showToast('已刷新', 'ok');
  } else if (action === 'toggle-mini') {
    platform.toggleMini();
  } else if (action === 'mini-refresh') {
    await refreshCounters();
    await refreshContent();
  } else if (action === 'mini-expand') {
    platform.invokeDesktop('mini-expand');
    platform.invokeDesktop('mini-close');
  } else if (action === 'mini-close') {
    platform.invokeDesktop('mini-close');
  } else if (action === 'sort') {
    state.sort = target.dataset.sort;
    render();
  } else if (action === 'pick-cover') {
    openFilePicker(document.getElementById('cover-file'));
  } else if (action === 'clear-cover') {
    state.publish.cover = null;
    render();
  } else if (action === 'import-md') {
    openFilePicker(document.getElementById('import-file'));
  } else if (action === 'pick-moment-images') {
    openFilePicker(document.getElementById('moment-images'));
  } else if (action === 'remove-moment-image') {
    state.moments.images.splice(Number(target.dataset.index), 1);
    render();
  } else if (action === 'publish-moment') {
    await submitMoment();
  } else if (action === 'clear-moment') {
    state.moments.draft = freshMomentDraft();
    state.moments.images = [];
    state.moments.progress = [];
    state.moments.error = null;
    state.moments.result = null;
    state.moments.deployResult = null;
    state.moments.cancelDeploy = false;
    platform.storage.set('momentDraft', null).catch(() => {});
    render();
  } else if (action === 'open-moment') {
    platform.openExternal(target.dataset.url || '');
  } else if (action === 'cancel-moment-deploy') {
    state.moments.cancelDeploy = true;
  } else if (action === 'publish') {
    await submitPublish();
  } else if (action === 'clear-draft') {
    state.publish.draft = freshDraft();
    state.publish.cover = null;
    state.publish.error = null;
    state.publish.progress = [];
    state.publish.result = null;
    state.publish.deployResult = null;
    state.publish.slugTouched = false;
    platform.storage.set('publishDraft', null).catch(() => {});
    render();
  } else if (action === 'goto-settings') {
    state.tab = 'settings';
    render();
  } else if (action === 'token-save') {
    await saveToken();
  } else if (action === 'token-test') {
    await testToken();
  } else if (action === 'token-clear') {
    try {
      await platform.token.clear();
      state.tokenPresent = false;
      state.tokenLogin = '';
      if (!canPublishNow() && state.tab === 'publish') state.tab = 'overview';
      if (!canMomentsNow() && state.tab === 'moments') state.tab = 'overview';
      showToast('Token 已清除', 'ok');
      render();
    } catch (error) {
      showToast(error.message, 'err');
    }
  } else if (action === 'check-update') {
    await checkUpdates(true);
  } else if (action === 'update-download') {
    const info = state.updates.info;
    if (info && (info.url || info.pageUrl)) {
      platform.openExternal(info.url || info.pageUrl);
    }
  } else if (action === 'update-dismiss') {
    await dismissUpdate();
  } else if (action === 'update-backdrop') {
    if (event.target !== target) return;
    await dismissUpdate();
  } else if (action === 'settings-save') {
    await saveSettings();
  } else if (action === 'reset-data') {
    await platform.storage.set('snapshot', null);
    await platform.storage.set('words', { commit: '', items: {} });
    state.snapshot = null;
    state.health = { counters: null, content: null };
    showToast('缓存已清除，正在重新同步', 'ok');
    await refreshContent();
    await refreshCounters();
  } else if (action === 'use-suggested') {
    state.publish.draft.slugOverride = target.dataset.slug || '';
    state.publish.slugTouched = true;
    state.publish.error = null;
    render();
  } else if (action === 'open-post') {
    platform.openExternal(target.dataset.url || '');
  } else if (action === 'cancel-deploy') {
    state.publish.cancelDeploy = true;
  }
}

function handleInput(event) {
  const input = event.target;
  if (input.dataset && input.dataset.momentField) {
    const field = input.dataset.momentField;
    state.moments.draft[field] = input.value;
    const counter = document.getElementById('moment-text-count');
    if (field === 'text' && counter) counter.textContent = String(charLength(input.value));
    scheduleMomentDraftSave();
    return;
  }
  if (input.dataset && input.dataset.field) {
    const field = input.dataset.field;
    if (field === 'draft') return;
    state.publish.draft[field] = input.value;
    if (field === 'slugOverride') state.publish.slugTouched = Boolean(input.value.trim());
    updateDraftUI();
    scheduleDraftSave();
    return;
  }
  if (input.dataset && input.dataset.setting) {
    const key = input.dataset.setting;
    state.settings[key] = input.type === 'number' ? Number(input.value) : input.checked;
  }
}

function handleChange(event) {
  const input = event.target;
  if (input.id === 'moment-images') {
    if (input.files && input.files.length) {
      addMomentImages(input.files);
    } else {
      showToast('没有选择图片', 'err');
    }
    input.value = '';
    return;
  }
  if (input.id === 'cover-file' && input.files && input.files[0]) {
    loadCover(input.files[0]);
    return;
  }
  if (input.id === 'import-file' && input.files && input.files[0]) {
    importMarkdown(input.files[0]);
    return;
  }
  if (input.dataset && input.dataset.field === 'draft') {
    state.publish.draft.draft = input.checked;
    scheduleDraftSave();
    return;
  }
  if (input.dataset && input.dataset.setting && input.type === 'checkbox') {
    state.settings[input.dataset.setting] = input.checked;
  }
}

function updateDraftUI() {
  const draft = state.publish.draft;
  const slugPreview = document.getElementById('slug-preview');
  if (slugPreview) slugPreview.textContent = `/${currentSlug()}/`;
  const excerptCount = document.getElementById('excerpt-count');
  if (excerptCount) excerptCount.textContent = String(charLength(draft.excerpt));
  const stats = draftStats(draft.body);
  const statsEl = document.getElementById('draft-stats');
  if (statsEl) statsEl.textContent = `${formatNumber(stats.words)} 字 · 约 ${stats.readMinutes} 分钟阅读`;
  const preview = document.getElementById('body-preview');
  if (preview) {
    clearTimeout(updateDraftUI.previewTimer);
    updateDraftUI.previewTimer = setTimeout(() => {
      if (document.getElementById('body-preview')) {
        document.getElementById('body-preview').innerHTML = renderMarkdown(state.publish.draft.body);
      }
    }, 250);
  }
}

function scheduleDraftSave() {
  clearTimeout(state.draftSaveTimer);
  state.draftSaveTimer = setTimeout(() => {
    const draft = state.publish.draft;
    if (!draft.title && !draft.body) return;
    platform.storage.set('publishDraft', draft).catch(() => {});
  }, 700);
}

function imageMimeFor(file) {
  const declared = String(file.type || '').toLowerCase();
  if (declared.startsWith('image/')) return declared;
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return '';
}

async function loadCover(file) {
  const mime = imageMimeFor(file);
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    showToast('封面仅支持 JPG/PNG/WebP', 'err');
    return;
  }
  if (file.size > DEFAULTS.publish.maxCoverBytes) {
    showToast('封面不能超过 5MB', 'err');
    return;
  }
  try {
    const image = await prepareImage(file, { maxEdge: 1800, quality: 0.88, type: mime });
    state.publish.cover = { base64: image.base64, mime: image.mime, name: image.name, size: image.size };
    state.publish.draft.coverUrl = '';
    state.publish.error = null;
    render();
  } catch (error) {
    showToast(`${file.name} 读取失败`, 'err');
  }
}

function scheduleMomentDraftSave() {
  clearTimeout(state.momentDraftSaveTimer);
  state.momentDraftSaveTimer = setTimeout(() => {
    const draft = state.moments.draft;
    if (!draft.text && !draft.date) return;
    platform.storage.set('momentDraft', draft).catch(() => {});
  }, 600);
}

async function addMomentImages(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const room = DEFAULTS.moments.maxImages - state.moments.images.length;
  if (room <= 0) {
    showToast(`最多上传 ${DEFAULTS.moments.maxImages} 张图片`, 'err');
    return;
  }
  const added = [];
  for (const file of files.slice(0, room)) {
    const mime = imageMimeFor(file);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
      showToast(`${file.name} 不是支持的图片格式`, 'err');
      continue;
    }
    if (file.size > DEFAULTS.moments.maxImageBytes) {
      showToast(`${file.name} 超过 5MB`, 'err');
      continue;
    }
    try {
      const image = await prepareImage(file, { maxEdge: 1600, quality: 0.86, type: mime });
      added.push({ base64: image.base64, mime: image.mime, name: image.name, size: image.size });
    } catch (error) {
      showToast(`${file.name} 读取失败`, 'err');
    }
  }
  state.moments.images = state.moments.images.concat(added);
  state.moments.error = null;
  if (files.length > room) showToast(`最多上传 ${DEFAULTS.moments.maxImages} 张图片`, 'err');
  render();
}

function encodeImage(dataUrl, { mime, maxEdge = 1600, quality = 0.86 } = {}) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob || blob.type !== mime) return resolve(null);
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              base64: String(reader.result).replace(/^data:[^;]+;base64,/, ''),
              mime,
              size: blob.size,
            });
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        }, mime, quality);
      } catch (error) {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

async function prepareImage(file, { maxEdge = 1600, quality = 0.86, type = '' } = {}) {
  const mime = type || file.type || 'image/jpeg';
  let dataUrl = await readFileAsDataUrl(file);
  if (mime && /^data:/i.test(dataUrl) && !dataUrl.toLowerCase().startsWith(`data:${mime}`)) {
    // Some Android file managers report application/octet-stream; give the
    // data URL the MIME type implied by the extension so <img> can decode it.
    dataUrl = dataUrl.replace(/^data:[^;,]*/i, `data:${mime}`);
  }
  const base64 = String(dataUrl).replace(/^data:[^;]+;base64,/, '');
  const original = { base64, mime, size: file.size, name: file.name || 'image' };
  const limit = DEFAULTS.publish.maxCoverBytes;

  if (mime === 'image/webp') {
    if (file.size > 1.5 * 1024 * 1024) {
      const shrunk = await encodeImage(dataUrl, { mime: 'image/webp', maxEdge, quality });
      if (shrunk && shrunk.size < file.size) return { ...shrunk, name: file.name };
    }
    return original;
  }

  const webp = await encodeImage(dataUrl, { mime: 'image/webp', maxEdge, quality });
  if (webp && webp.size <= limit) return { ...webp, name: file.name };

  // 极少数环境不支持 canvas 导出 WebP，退回到原图（仍满足大小限制）。
  if (file.size > 1.5 * 1024 * 1024) {
    const jpeg = await encodeImage(dataUrl, { mime: 'image/jpeg', maxEdge, quality });
    if (jpeg && jpeg.size < file.size) return { ...jpeg, name: file.name };
  }
  return original;
}

async function submitMoment() {
  if (state.moments.saving) return;
  const moment = state.moments;
  moment.error = null;
  moment.result = null;
  moment.progress = [];
  moment.deployResult = null;
  moment.cancelDeploy = false;

  if (!state.tokenPresent) {
    moment.error = { code: 'NO_TOKEN', message: '请先在设置中保存 GitHub Token' };
    render();
    return;
  }

  moment.saving = true;
  render();
  try {
    const publisher = createMomentPublisher({
      transport: platform.github,
      config: { moments: DEFAULTS.moments },
    });
    const result = await publisher.publish(
      { text: moment.draft.text, date: moment.draft.date, images: moment.images },
      {
        onProgress: (progress) => {
          moment.progress.push(progress);
          updateMomentLive();
        },
      },
    );
    moment.result = result;
    moment.deploying = true;
    moment.deployAttempts = 0;
    moment.draft = freshMomentDraft();
    moment.images = [];
    await platform.storage.set('momentDraft', null).catch(() => {});
    render();
    if (state.settings.notifications) {
      platform.notify('动态已提交', '已推送到仓库，正在等待部署');
    }
    pollMomentDeploy(result.id);
  } catch (error) {
    moment.error = {
      code: error.code || 'ERROR',
      message: error.message || String(error),
      fields: error.fields,
    };
    render();
  } finally {
    moment.saving = false;
    const button = document.querySelector('[data-action="publish-moment"]');
    if (button) {
      button.disabled = false;
      button.textContent = '发布动态';
    }
    updateMomentLive();
  }
}

async function pollMomentDeploy(id) {
  const moment = state.moments;
  try {
    const result = await waitForMomentDeploy({
      httpText: platform.httpText,
      siteUrl: DEFAULTS.siteUrl,
      id,
      timeoutMs: DEFAULTS.intervals.deployTimeout,
      intervalMs: DEFAULTS.intervals.deployPoll,
      onTick: (attempts) => {
        moment.deployAttempts = attempts;
        updateMomentLive();
      },
      isCancelled: () => moment.cancelDeploy,
    });
    moment.deployResult = result;
    if (result.deployed && state.settings.notifications) {
      platform.notify('动态已上线', `${DEFAULTS.siteUrl}/moments/${id}/ 可以访问了`);
    }
  } catch (error) {
    moment.deployResult = { deployed: false, timeout: true, error: error.message };
  } finally {
    moment.deploying = false;
    updateMomentLive();
  }
}

function updateMomentLive() {
  const box = document.getElementById('moment-live');
  if (!box) return;
  box.innerHTML = renderMomentLive();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

async function importMarkdown(file) {
  try {
    const text = await readFileAsText(file);
    let body = text.replace(/^\uFEFF/, '');
    let data = {};
    const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (match) {
      try {
        data = YAML.parse(match[1]) || {};
      } catch (error) {
        showToast(`Frontmatter 解析失败：${error.message}`, 'err');
        return;
      }
      body = body.slice(match[0].length);
    }
    const draft = freshDraft();
    if (data.title) draft.title = String(data.title);
    if (data.excerpt) draft.excerpt = String(data.excerpt);
    if (data.category) draft.category = String(data.category);
    if (Array.isArray(data.tags)) draft.tags = data.tags.join(', ');
    else if (data.tags) draft.tags = String(data.tags);
    if (data.author) draft.author = String(data.author);
    if (data.publishDate) draft.publishDate = toLocalInput(data.publishDate);
    if (data.imageAlt) draft.imageAlt = String(data.imageAlt);
    if (typeof data.image === 'string' && /^https?:\/\//i.test(data.image)) draft.coverUrl = data.image;
    draft.draft = Boolean(data.draft);
    draft.body = body.replace(/^\s*\n/, '');
    state.publish.draft = draft;
    state.publish.cover = null;
    state.publish.error = null;
    state.publish.slugTouched = false;
    showToast('已导入 Markdown', 'ok');
    render();
  } catch (error) {
    showToast(error.message, 'err');
  }
}

async function submitPublish() {
  if (state.loading.publish) return;
  const publish = state.publish;
  publish.error = null;
  publish.result = null;
  publish.progress = [];
  publish.deployResult = null;
  publish.cancelDeploy = false;

  if (!state.tokenPresent) {
    publish.error = { code: 'NO_TOKEN', message: '请先在设置中保存 GitHub Token' };
    render();
    return;
  }

  state.loading.publish = true;
  render();
  try {
    const publisher = createPublisher({
      transport: platform.github,
      config: {
        publish: Object.assign({}, DEFAULTS.publish, {
          author: publish.draft.author || DEFAULTS.publish.author,
        }),
      },
    });
    const result = await publisher.publish(
      Object.assign({}, publish.draft, { cover: publish.cover }),
      {
        onProgress: (progress) => {
          publish.progress.push(progress);
          updatePublishLive();
        },
      },
    );
    publish.result = result;
    publish.deploying = true;
    publish.deployAttempts = 0;
    publish.draft = freshDraft();
    publish.cover = null;
    publish.slugTouched = false;
    await platform.storage.set('publishDraft', null).catch(() => {});
    refreshContent().catch(() => {});
    render();
    if (state.settings.notifications) {
      platform.notify('博客已提交', `${result.title} 已推送到仓库，正在等待部署`);
    }
    pollDeploy(result.slug);
  } catch (error) {
    publish.error = {
      code: error.code || 'ERROR',
      message: error.message || String(error),
      fields: error.fields,
      suggestedSlug: error.suggestedSlug,
    };
    render();
  } finally {
    state.loading.publish = false;
    const button = document.querySelector('[data-action="publish"]');
    if (button) {
      button.disabled = false;
      button.textContent = '发布到 GitHub';
    }
    updatePublishLive();
  }
}

async function pollDeploy(slug) {
  const publish = state.publish;
  try {
    const result = await waitForDeploy({
      httpText: platform.httpText,
      siteUrl: DEFAULTS.siteUrl,
      slug,
      timeoutMs: DEFAULTS.intervals.deployTimeout,
      intervalMs: DEFAULTS.intervals.deployPoll,
      onTick: (attempts) => {
        publish.deployAttempts = attempts;
        updatePublishLive();
      },
      isCancelled: () => publish.cancelDeploy,
    });
    publish.deployResult = result;
    if (result.deployed && state.settings.notifications) {
      platform.notify('博客已上线', `${DEFAULTS.siteUrl}/${slug}/ 可以访问了`);
    }
  } catch (error) {
    publish.deployResult = { deployed: false, timeout: true, error: error.message };
  } finally {
    publish.deploying = false;
    updatePublishLive();
  }
}

function updatePublishLive() {
  const box = document.getElementById('publish-live');
  if (!box) return;
  box.innerHTML = renderPublishLive();
}

async function saveToken() {
  const input = document.getElementById('token-input');
  if (!input) return;
  const value = input.value.trim();
  if (!value) {
    showToast('请先粘贴 Token', 'err');
    return;
  }
  try {
    await platform.token.set(value);
    state.tokenPresent = true;
    input.value = '';
    let message = 'Token 已保存';
    try {
      const response = await platform.testToken();
      if (response && response.status === 200 && response.json && response.json.login) {
        state.tokenLogin = response.json.login;
        message = `Token 已保存（@${response.json.login}）`;
      } else {
        const detail = response && response.json && response.json.message;
        message = `Token 已保存，但校验未通过${detail ? `：${detail}` : ''}`;
      }
    } catch (error) {
      message = `Token 已保存，但校验失败：${error.message}`;
    }
    showToast(message, 'ok');
    render();
  } catch (error) {
    showToast(`保存 Token 失败：${error.message}`, 'err');
  }
}

async function testToken() {
  try {
    const response = await platform.testToken();
    if (response && response.status === 200 && response.json && response.json.login) {
      state.tokenLogin = response.json.login;
      showToast(`Token 有效：@${response.json.login}`, 'ok');
    } else {
      const message = response && response.json && response.json.message;
      showToast(`Token 校验失败${message ? `：${message}` : ''}`, 'err');
    }
    render();
  } catch (error) {
    showToast(error.message, 'err');
  }
}

async function checkUpdates(manual) {
  if (state.updates.checking) return;
  state.updates.checking = true;
  if (manual) render();
  try {
    const result = await checkForUpdate({
      httpText: githubText,
      repo: DEFAULTS.updates.repo,
      currentVersion: VERSION,
      kind: platform.kind,
    });
    state.updates.checkedAt = Date.now();
    if (!result.checked) {
      state.updates.info = null;
      state.updates.error = result.error || '检查更新失败';
      if (manual) showToast(state.updates.error, 'err');
      return;
    }
    state.updates.error = null;
    if (result.newer && result.release) {
      state.updates.info = {
        version: result.release.version.replace(/^v/i, ''),
        notes: result.release.notes,
        pageUrl: result.release.htmlUrl,
        url: result.downloadUrl || '',
        hasAsset: Boolean(result.downloadUrl),
      };
      if (manual) showToast(`发现新版本 v${state.updates.info.version}`, 'ok');
    } else {
      state.updates.info = null;
      if (manual) showToast('已是最新版本', 'ok');
    }
  } catch (error) {
    state.updates.error = `检查更新失败：${error.message || error}`;
    if (manual) showToast(state.updates.error, 'err');
  } finally {
    state.updates.checking = false;
    render();
  }
}

async function dismissUpdate() {
  const info = state.updates.info;
  if (!info) return;
  state.updates.dismissed = info.version;
  await platform.storage.set(DEFAULTS.updates.dismissedKey, info.version).catch(() => {});
  render();
}

async function saveSettings() {
  const counters = Math.min(3600, Math.max(30, Number(state.settings.countersSec) || 90));
  const content = Math.min(180, Math.max(1, Number(state.settings.contentMin) || 10));
  state.settings.countersSec = counters;
  state.settings.contentMin = content;
  try {
    await platform.settingsStore.set('config', state.settings);
    scheduleTimers();
    applyWindowPrefs();
    showToast('设置已保存', 'ok');
    render();
  } catch (error) {
    showToast(`保存设置失败：${error.message}`, 'err');
  }
}

function startTicker() {
  clearInterval(state.relativeTimer);
  state.relativeTimer = setInterval(() => {
    document.querySelectorAll('[data-relative]').forEach((element) => {
      const value = Number(element.dataset.relative);
      if (Number.isFinite(value) && value > 0) element.textContent = relativeTime(value);
    });
  }, 30000);
}

function showToast(message, kind) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast ${kind || ''}`;
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3600);
}

init().catch((error) => {
  if (appRoot()) {
    appRoot().innerHTML = `<div class="shell"><div class="card notice bad">启动失败：${escapeHtml(error.message || String(error))}</div></div>`;
  }
});
