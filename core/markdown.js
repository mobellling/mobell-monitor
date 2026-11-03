'use strict';

const { escapeHtml, countWords } = require('./util');

function inline(text) {
  let value = escapeHtml(text);
  value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  value = value.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<img alt="$1" src="$2" loading="lazy">');
  value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return value;
}

function renderMarkdown(markdown) {
  const source = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const out = [];
  let paragraph = [];
  let listType = '';
  let inCode = false;
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listType) return;
    out.push(`</${listType}>`);
    listType = '';
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (inCode) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCode = false;
        codeLines = [];
      } else {
        codeLines.push(rawLine);
      }
      continue;
    }
    if (/^```/.test(line)) {
      flushParagraph();
      closeList();
      inCode = true;
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^(\*\s*){3,}$/.test(line) || /^(-\s*){3,}$/.test(line)) {
      flushParagraph();
      closeList();
      out.push('<hr>');
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = unordered ? 'ul' : 'ol';
      if (listType !== nextType) {
        closeList();
        listType = nextType;
        out.push(`<${listType}>`);
      }
      out.push(`<li>${inline((unordered || ordered)[1])}</li>`);
      continue;
    }
    paragraph.push(line);
  }
  if (inCode) out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  flushParagraph();
  closeList();
  return out.join('\n');
}

function draftStats(body) {
  const words = countWords(body);
  return {
    cjk: words.cjk,
    latin: words.latin,
    words: words.words,
    chars: Array.from(String(body || '')).length,
    readMinutes: Math.max(1, Math.round(words.words / 400)),
  };
}

module.exports = { renderMarkdown, draftStats };
