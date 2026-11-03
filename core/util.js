'use strict';

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value) {
  return String(value == null ? '' : value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = NAMED[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function stripHtml(html) {
  const text = String(html == null ? '' : html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

function countWords(text) {
  const value = String(text == null ? '' : text);
  const cjk = (value.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (value.match(/[A-Za-z0-9_]+/g) || []).length;
  return { cjk, latin, words: cjk + latin };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit(items, limit, fn, gapMs) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit || 1, list.length || 1)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      try {
        out[index] = await fn(list[index], index);
      } catch (error) {
        out[index] = { __error: error };
      }
      if (gapMs) await sleep(gapMs);
    }
  });
  await Promise.all(workers);
  return out;
}

function b64encode(text) {
  const value = String(text == null ? '' : text);
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'utf8').toString('base64');
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64decode(value) {
  const text = String(value == null ? '' : value);
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'base64').toString('utf8');
  const binary = atob(text);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('zh-CN').format(n);
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function relativeTime(value, now) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const current = now ? new Date(now) : new Date();
  const diff = current.getTime() - date.getTime();
  if (diff < 0) return '刚刚';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatDate(date);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(value, max) {
  const chars = Array.from(String(value == null ? '' : value));
  return chars.length <= max ? chars.join('') : chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

function safeParseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return fallback === undefined ? null : fallback;
  }
}

function uniqueBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function todayKey(date) {
  const d = date instanceof Date ? date : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = {
  decodeEntities, stripHtml, countWords, sleep, mapLimit, b64encode, b64decode,
  formatNumber, formatDate, relativeTime, escapeHtml, truncate, safeParseJson,
  uniqueBy, todayKey,
};
