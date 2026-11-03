'use strict';

const {
  parseBlogList, parsePostPage, parseRss, parseRssMeta, parseCommitsJson, parseVercount,
  parseDiscussions, parseDiscussionsJson,
} = require('./parse');
const { mapLimit, safeParseJson } = require('./util');
const { normalizeTerm } = require('./slug');

function buildVercountUrl(endpoint, fullUrl) {
  return `${endpoint}?url=${encodeURIComponent(fullUrl)}`;
}

async function fetchSiteCounts({ httpText, siteUrl, endpoint }) {
  const text = await httpText(buildVercountUrl(endpoint, `${siteUrl.replace(/\/+$/, '')}/`));
  const counts = parseVercount(text);
  if (!counts.sitePv && !counts.siteUv) {
    throw new Error('Vercount 未返回站点数据');
  }
  return { sitePv: counts.sitePv, siteUv: counts.siteUv };
}

async function fetchPostViews({ httpText, endpoint, posts, concurrency = 3, gapMs = 120 }) {
  const results = await mapLimit(
    posts,
    concurrency,
    async (post) => {
      const text = await httpText(buildVercountUrl(endpoint, post.url));
      const counts = parseVercount(text);
      return { slug: post.slug, views: counts.pagePv };
    },
    gapMs,
  );
  const views = {};
  const errors = [];
  results.forEach((result, index) => {
    if (result && result.__error) {
      errors.push({ slug: posts[index].slug, error: String(result.__error.message || result.__error) });
      return;
    }
    views[result.slug] = result.views;
  });
  return { views, errors };
}

async function discoverPosts({ httpText, siteUrl, maxPages = 10, onPage }) {
  const posts = [];
  const seen = new Set();
  let lastError = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const url = page === 1 ? `${siteUrl}/blog/` : `${siteUrl}/blog/${page}/`;
    let html;
    try {
      html = await httpText(url);
    } catch (error) {
      lastError = error;
      if (page === 1) throw error;
      break;
    }
    const items = parseBlogList(html);
    if (!items.length) break;
    for (const item of items) {
      const absolute = new URL(item.path, `${siteUrl}/`).href;
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      const slug = normalizeTerm(new URL(absolute).pathname);
      posts.push({ url: absolute, path: item.path, slug, listTitle: item.title });
    }
    if (onPage) onPage(page, items.length, posts.length);
  }
  if (!posts.length) {
    throw lastError || new Error('未能从博客列表解析文章');
  }
  return posts;
}

async function discoverPostsFromRss({ httpText, siteUrl }) {
  const xml = await httpText(`${siteUrl}/rss.xml`);
  const items = parseRss(xml);
  if (!items.length) throw new Error('RSS 中没有文章');
  return items.map((item) => {
    const url = new URL(cleanUrl(item.link), `${siteUrl}/`).href;
    return {
      url,
      path: new URL(url).pathname,
      slug: normalizeTerm(new URL(url).pathname),
      listTitle: item.title,
      publishDate: item.pubDate ? new Date(item.pubDate).toISOString() : null,
    };
  });
}

function cleanUrl(value) {
  return String(value == null ? '' : value).trim();
}

async function fetchPostDetail({ httpText, url }) {
  const html = await httpText(url);
  const detail = parsePostPage(html);
  if (!detail.title) throw new Error('文章页解析失败');
  return detail;
}

async function fetchComments({ httpText, github, repo, maxPages = 3 }) {
  try {
    return await commentsFromApi({ httpText, github, repo, maxPages });
  } catch (apiError) {
    try {
      return await commentsFromHtml({ httpText, repo, maxPages });
    } catch (htmlError) {
      throw new Error(`评论数据获取失败：${apiError.message}；页面解析失败：${htmlError.message}`);
    }
  }
}

async function commentsFromApi({ httpText, github, repo, maxPages }) {
  const byTerm = {};
  let total = 0;
  let pages = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const path = `/repos/${repo}/discussions?per_page=100&page=${page}`;
    let data;
    if (github) {
      const response = await github(path);
      if (!response || response.status >= 400) {
        throw new Error(`GitHub API 返回 ${response ? response.status : '无响应'}`);
      }
      data = response.json;
    } else {
      const text = await httpText(`https://api.github.com${path}`);
      data = safeParseJson(text, null);
    }
    const parsed = parseDiscussionsJson(data);
    if (!parsed.discussions.length) {
      if (page === 1) throw new Error('GitHub API 未返回讨论数据');
      break;
    }
    pages += 1;
    for (const [term, count] of Object.entries(parsed.byTerm)) {
      byTerm[term] = (byTerm[term] || 0) + count;
    }
    total += parsed.total;
    if (parsed.discussions.length < 100) break;
  }
  return { byTerm, total, pages, source: 'api' };
}

async function commentsFromHtml({ httpText, repo, maxPages }) {
  let url = `https://github.com/${repo}/discussions`;
  const byTerm = {};
  let total = 0;
  let pages = 0;
  for (let page = 0; page < maxPages && url; page += 1) {
    const html = await httpText(url);
    const parsed = parseDiscussions(html);
    pages += 1;
    for (const [term, count] of Object.entries(parsed.byTerm)) {
      byTerm[term] = (byTerm[term] || 0) + count;
    }
    total += parsed.total;
    const next = extractNextLink(html);
    url = next ? new URL(next, 'https://github.com').href : null;
  }
  if (!pages) throw new Error('讨论页面为空');
  return { byTerm, total, pages, source: 'html' };
}

function extractNextLink(html) {
  const source = String(html == null ? '' : html);
  let match = source.match(/<a[^>]*rel="next"[^>]*href="([^"]+)"/i);
  if (!match) match = source.match(/<a[^>]*href="([^"]+)"[^>]*rel="next"/i);
  return match ? match[1] : null;
}

async function fetchLatestCommit({ httpText, github, repo, siteUrl }) {
  let apiError = null;
  try {
    const path = `/repos/${repo}/commits?per_page=1`;
    let data;
    if (github) {
      const response = await github(path);
      if (!response || response.status >= 400) {
        throw new Error(`GitHub API 返回 ${response ? response.status : '无响应'}`);
      }
      data = response.json;
    } else {
      const text = await httpText(`https://api.github.com${path}`);
      data = safeParseJson(text, null);
    }
    const commit = parseCommitsJson(data);
    if (commit && commit.updated) return commit;
    throw new Error('提交记录为空');
  } catch (error) {
    apiError = error;
  }
  if (siteUrl) {
    try {
      const xml = await httpText(`${siteUrl}/rss.xml`);
      const meta = parseRssMeta(xml);
      const parsed = meta.lastBuildDate ? new Date(meta.lastBuildDate) : null;
      if (parsed && !Number.isNaN(parsed.getTime())) {
        return {
          sha: '',
          title: '站点构建完成（来自 RSS 构建时间）',
          updated: parsed.toISOString(),
          url: `${siteUrl}/`,
          source: 'rss',
        };
      }
    } catch (error) {
      // 保留原始 API 错误
    }
  }
  throw apiError || new Error('提交记录解析失败');
}

module.exports = {
  buildVercountUrl,
  fetchSiteCounts,
  fetchPostViews,
  discoverPosts,
  discoverPostsFromRss,
  fetchPostDetail,
  fetchComments,
  fetchLatestCommit,
};
