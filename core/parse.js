'use strict';

const { decodeEntities, stripHtml, countWords, safeParseJson } = require('./util');
const { normalizeTerm } = require('./slug');

function parseBlogList(html) {
  const source = String(html == null ? '' : html);
  const items = [];
  const re = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(source))) {
    const href = decodeEntities(match[1]).trim();
    if (!href.startsWith('/')) continue;
    if (/^\/(blog|tag|category|about|privacy|terms|rss|search|contact)(\/|$)/i.test(href)) continue;
    if (href.includes('#')) continue;
    items.push({ path: href, title: stripHtml(match[2]) });
  }
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}

function findProseStart(html) {
  const re = /<div[^>]*class="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = re.exec(html))) {
    const classes = match[1].split(/\s+/);
    if (classes.includes('prose')) return match.index;
  }
  return -1;
}

function parsePostPage(html) {
  const source = String(html == null ? '' : html);
  const titleMatch = source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const dateMatch = source.match(/<time[^>]*datetime="([^"]+)"/i);
  let content = '';
  const start = findProseStart(source);
  if (start >= 0) {
    const end = source.indexOf('</article>', start);
    content = source.slice(start, end > start ? end : Math.min(source.length, start + 400000));
  } else {
    const article = source.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    content = article ? article[1] : '';
  }
  const text = stripHtml(content);
  const words = countWords(text);
  return {
    title: stripHtml(titleMatch ? titleMatch[1] : ''),
    publishDate: dateMatch ? dateMatch[1] : null,
    text,
    cjk: words.cjk,
    latin: words.latin,
    words: words.words,
  };
}

function cleanCdata(value) {
  return stripHtml(String(value || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, ''));
}

function parseRss(xml) {
  const source = String(xml == null ? '' : xml);
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(source))) {
    const body = match[1];
    const pick = (tag) => {
      const m = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? m[1] : '';
    };
    const link = cleanCdata(pick('link'));
    if (!link) continue;
    items.push({
      title: cleanCdata(pick('title')),
      link,
      pubDate: cleanCdata(pick('pubDate')),
      description: cleanCdata(pick('description')),
    });
  }
  return items;
}

function parseCommitsAtom(xml) {
  const source = String(xml == null ? '' : xml);
  const entryMatch = source.match(/<entry>([\s\S]*?)<\/entry>/i);
  if (!entryMatch) return null;
  const entry = entryMatch[1];
  const pick = (tag) => {
    const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1] : '';
  };
  const id = pick('id');
  const shaMatch = id.match(/Grit::Commit\/([0-9a-f]{7,40})/i) || id.match(/([0-9a-f]{40})/i);
  return {
    sha: shaMatch ? shaMatch[1] : '',
    title: cleanCdata(pick('title')),
    updated: cleanCdata(pick('updated')),
    url: shaMatch ? `https://github.com/mobellling/mobellling.github.io/commit/${shaMatch[1]}` : '',
  };
}

function parseVercount(input) {
  const data = typeof input === 'string' ? safeParseJson(input, null) : input;
  const payload = data && data.data ? data.data : data || {};
  const toNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    sitePv: toNumber(payload.site_pv),
    siteUv: toNumber(payload.site_uv),
    pagePv: toNumber(payload.page_pv),
  };
}

function parseDiscussions(html) {
  const source = String(html == null ? '' : html);
  const titles = new Map();
  const titleRe = /href="[^"]*\/discussions\/(\d+)"[^>]*class="[^"]*markdown-title[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = titleRe.exec(source))) {
    const id = match[1];
    const title = stripHtml(match[2]);
    if (!titles.has(id)) titles.set(id, title);
  }
  const counts = new Map();
  const countRe = /<a[^>]*aria-label="(\d+) comments?:[^"]*"[^>]*href="[^"]*\/discussions\/(\d+)"/gi;
  while ((match = countRe.exec(source))) {
    counts.set(match[2], Number(match[1]));
  }
  const byTerm = {};
  let total = 0;
  const discussions = [];
  for (const [id, title] of titles) {
    const count = counts.get(id) || 0;
    const term = normalizeTerm(title);
    byTerm[term] = (byTerm[term] || 0) + count;
    total += count;
    discussions.push({ id, title, term, count });
  }
  return { byTerm, total, discussions };
}

function parseRssMeta(xml) {
  const source = String(xml == null ? '' : xml);
  const match = source.match(/<lastBuildDate>([\s\S]*?)<\/lastBuildDate>/i);
  return { lastBuildDate: match ? cleanCdata(match[1]) : null };
}

function parseDiscussionsJson(input) {
  const data = typeof input === 'string' ? safeParseJson(input, null) : input;
  const list = Array.isArray(data) ? data : data && Array.isArray(data.discussions) ? data.discussions : [];
  const byTerm = {};
  let total = 0;
  const discussions = [];
  for (const item of list) {
    if (!item || typeof item.title !== 'string') continue;
    const term = normalizeTerm(item.title);
    const count = Number(item.comments) || 0;
    byTerm[term] = (byTerm[term] || 0) + count;
    total += count;
    discussions.push({
      id: String(item.number || item.id || ''),
      title: item.title,
      term,
      count,
    });
  }
  return { byTerm, total, discussions };
}

function parseCommitsJson(input) {
  const data = typeof input === 'string' ? safeParseJson(input, null) : input;
  const list = Array.isArray(data) ? data : [];
  const item = list[0];
  if (!item || !item.sha) return null;
  const commit = item.commit || {};
  const message = String(commit.message || '').split('\n')[0].trim();
  return {
    sha: item.sha,
    title: message,
    updated: (commit.committer && commit.committer.date) || (commit.author && commit.author.date) || '',
    url: item.html_url || '',
  };
}

function parseRepoContents(input) {
  const data = typeof input === 'string' ? safeParseJson(input, null) : input;
  if (!Array.isArray(data)) return [];
  return data
    .filter((item) => item && item.type === 'file' && typeof item.name === 'string')
    .map((item) => ({
      name: item.name,
      path: item.path,
      sha: item.sha,
      size: item.size,
      downloadUrl: item.download_url,
    }));
}

module.exports = {
  parseBlogList, parsePostPage, parseRss, parseRssMeta, parseCommitsAtom, parseVercount,
  parseDiscussions, parseDiscussionsJson, parseCommitsJson, parseRepoContents,
};
