'use strict';

const limax = require('limax');

function slugify(input) {
  const value = String(input == null ? '' : input);
  let slug = '';
  try {
    slug = limax(value);
  } catch (error) {
    slug = value.toLowerCase();
  }
  return String(slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

function normalizeTerm(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

function uniqueSlug(slug, existing) {
  const base = String(slug || '').replace(/-+$/g, '');
  if (!base) return base;
  const taken = new Set((existing || []).map((item) => String(item).toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now()}`;
}

module.exports = { slugify, normalizeTerm, uniqueSlug };
