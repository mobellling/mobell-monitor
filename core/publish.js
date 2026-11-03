'use strict';

const { b64encode, sleep } = require('./util');
const { slugify, normalizeTerm, uniqueSlug } = require('./slug');
const { DEFAULTS } = require('./config');
const { parseRepoContents } = require('./parse');

class PublishError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.name = 'PublishError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

function quoteYaml(value) {
  const text = String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
  return `'${text.replace(/'/g, "''")}'`;
}

function toIso(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new PublishError('INVALID_DATE', '发布日期无效');
  return date.toISOString();
}

function charLength(value) {
  return Array.from(String(value == null ? '' : value)).length;
}

function normalizeTags(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,，\n]/);
  return list.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 8);
}

function extensionFor(mime, name) {
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  if (map[mime]) return map[mime];
  const match = String(name || '').match(/\.([a-zA-Z0-9]{2,5})$/);
  if (match && ['jpg', 'jpeg', 'png', 'webp'].includes(match[1].toLowerCase())) {
    return match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  }
  return '';
}

function validateDraft(draft) {
  const errors = {};
  const title = String(draft.title || '').trim();
  const excerpt = String(draft.excerpt || '').trim();
  const body = String(draft.body || '').replace(/\r\n?/g, '\n');
  const slug = draft.slugOverride ? String(draft.slugOverride).trim() : slugify(title);

  if (!title) errors.title = '请填写标题';
  else if (charLength(title) > 120) errors.title = '标题最多 120 字';
  if (charLength(excerpt) > 155) errors.excerpt = '摘要最多 155 字';
  if (!body.trim()) errors.body = '请填写正文';

  if (draft.publishDate) {
    try {
      toIso(draft.publishDate);
    } catch (error) {
      errors.publishDate = '发布日期无效';
    }
  }

  if (!slug) errors.slug = '标题无法生成有效 URL';
  else if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
    errors.slug = 'URL 仅允许小写字母、数字、连字符，且不能超过 80 字符';
  }

  if (draft.cover && draft.cover.base64) {
    const mime = draft.cover.mime || '';
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
      errors.cover = '封面仅支持 JPG/PNG/WebP';
    } else if (Number(draft.cover.size) > DEFAULTS.publish.maxCoverBytes) {
      errors.cover = '封面不能超过 5MB';
    }
    if (!extensionFor(mime, draft.cover.name)) errors.cover = '无法识别封面格式';
  }

  return { errors, title, excerpt, body, slug };
}

function coverTimestamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function buildPostFiles(draft, options) {
  const opts = Object.assign({}, DEFAULTS.publish, options || {});
  const validated = validateDraft(draft);
  if (Object.keys(validated.errors).length) {
    throw new PublishError('VALIDATION', '表单校验未通过', { fields: validated.errors });
  }
  const { title, excerpt, body, slug } = validated;
  const publishDate = toIso(draft.publishDate);
  const category = String(draft.category || opts.defaultCategory || 'Other').trim() || 'Other';
  const author = String(draft.author || opts.author || 'Mobell').trim() || 'Mobell';
  const tags = normalizeTags(draft.tags);
  const isDraft = Boolean(draft.draft);

  const files = [];
  let image = '';
  let imageAlt = '';
  if (draft.cover && draft.cover.base64 && draft.cover.mime) {
    const ext = extensionFor(draft.cover.mime, draft.cover.name);
    const filename = `${slug}-${coverTimestamp()}.${ext}`;
    const coverPath = `${opts.uploadDir}/${filename}`;
    const raw = String(draft.cover.base64).replace(/^data:[^;]+;base64,/, '');
    files.push({ path: coverPath, base64: raw, binary: true });
    image = `~/${coverPath}`;
    imageAlt = String(draft.imageAlt || title).trim();
  } else if (draft.coverUrl) {
    image = String(draft.coverUrl).trim();
    imageAlt = String(draft.imageAlt || title).trim();
  }

  const lines = ['---'];
  lines.push(`publishDate: ${publishDate}`);
  lines.push(`title: ${quoteYaml(title)}`);
  if (excerpt) lines.push(`excerpt: ${quoteYaml(excerpt)}`);
  if (image) {
    lines.push(`image: ${quoteYaml(image)}`);
    if (imageAlt) lines.push(`imageAlt: ${quoteYaml(imageAlt)}`);
  }
  lines.push(`category: ${quoteYaml(category)}`);
  if (tags.length) {
    lines.push('tags:');
    for (const tag of tags) lines.push(`  - ${quoteYaml(tag)}`);
  }
  lines.push(`author: ${quoteYaml(author)}`);
  if (isDraft) lines.push('draft: true');
  lines.push('---', '', body.trimEnd(), '');
  const markdown = lines.join('\n');

  const postPath = `${opts.postDir}/${slug}.md`;
  files.unshift({ path: postPath, base64: b64encode(markdown), binary: false, markdown });
  const siteUrl = String((options && options.siteUrl) || DEFAULTS.siteUrl).replace(/\/+$/, '');

  return {
    slug,
    title,
    postPath,
    markdown,
    files,
    publishDate,
    isDraft,
    url: `${siteUrl}/${slug}/`,
    commitMessage: isDraft ? `post: 保存草稿《${title}》` : `post: 添加《${title}》`,
  };
}

function createPublisher({ transport, config }) {
  const opts = Object.assign({}, DEFAULTS.publish, (config && config.publish) || {});
  if (!transport || typeof transport.request !== 'function') {
    throw new Error('createPublisher 需要 transport.request');
  }
  const { owner, repo, branch } = opts;

  async function request(method, path, body) {
    let response;
    try {
      response = await transport.request({ method, path, body });
    } catch (error) {
      throw new PublishError('NETWORK', `网络请求失败：${error.message || error}`);
    }
    if (!response || typeof response.status !== 'number') {
      throw new PublishError('NETWORK', 'GitHub 请求没有返回状态');
    }
    const json = response.json;
    if (response.status >= 200 && response.status < 300) return json;
    let message = json && json.message;
    if (!message && json && Array.isArray(json.errors)) {
      message = json.errors.map((item) => item.message || item.code).filter(Boolean).join('; ');
    }
    if (response.status === 401) message = message || 'Token 无效或已过期';
    if (response.status === 403) message = message || 'Token 无写权限或触发限流';
    throw new PublishError(`GITHUB_${response.status}`, message || `GitHub 返回 ${response.status}`, {
      status: response.status,
      data: json,
    });
  }

  async function listExistingPosts() {
    const data = await request('GET', `/repos/${owner}/${repo}/contents/${opts.postDir}?ref=${encodeURIComponent(branch)}`);
    return parseRepoContents(data).map((file) => ({
      name: file.name,
      slug: slugify(file.name.replace(/\.mdx?$/i, '')),
    }));
  }

  async function publish(draft, handlers) {
    const hooks = Object.assign({ onProgress: () => {} }, handlers || {});
    const payload = buildPostFiles(draft, opts);
    hooks.onProgress({ step: 'validate', message: '内容校验通过' });

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let step = 'collision';
      try {
        const existing = await listExistingPosts();
        const taken = existing.map((item) => item.slug);
        const collision = taken.some((item) => item.toLowerCase() === payload.slug.toLowerCase());
        if (collision) {
          const suggested = uniqueSlug(payload.slug, taken);
          throw new PublishError('SLUG_EXISTS', `已有文章使用 URL /${payload.slug}/`, {
            suggestedSlug: suggested,
          });
        }
        hooks.onProgress({ step: 'collision', message: '未发现同名文章' });

        step = 'ref';
        const ref = await request('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
        const headSha = ref && ref.object && ref.object.sha;
        if (!headSha) throw new PublishError('REF_MISSING', '无法读取分支 head');
        const headCommit = await request('GET', `/repos/${owner}/${repo}/git/commits/${headSha}`);
        const baseTree = headCommit && headCommit.tree && headCommit.tree.sha;
        if (!baseTree) throw new PublishError('TREE_MISSING', '无法读取 head 的 tree');

        step = 'blob';
        const entries = [];
        for (const file of payload.files) {
          hooks.onProgress({ step: 'blob', message: `上传 ${file.path}` });
          const blob = await request('POST', `/repos/${owner}/${repo}/git/blobs`, {
            content: file.base64,
            encoding: 'base64',
          });
          if (!blob || !blob.sha) throw new PublishError('BLOB_FAILED', '创建 blob 失败');
          entries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
        }

        step = 'tree';
        hooks.onProgress({ step: 'tree', message: '创建目录树' });
        const tree = await request('POST', `/repos/${owner}/${repo}/git/trees`, {
          base_tree: baseTree,
          tree: entries,
        });
        if (!tree || !tree.sha) throw new PublishError('TREE_FAILED', '创建 tree 失败');

        step = 'commit';
        hooks.onProgress({ step: 'commit', message: '创建提交' });
        const commit = await request('POST', `/repos/${owner}/${repo}/git/commits`, {
          message: payload.commitMessage,
          tree: tree.sha,
          parents: [headSha],
        });
        if (!commit || !commit.sha) throw new PublishError('COMMIT_FAILED', '创建 commit 失败');

        step = 'ref-update';
        hooks.onProgress({ step: 'ref-update', message: '更新 master' });
        await request('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
          sha: commit.sha,
          force: false,
        });

        hooks.onProgress({ step: 'done', message: '提交成功' });
        return {
          commitSha: commit.sha,
          commitUrl: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
          slug: payload.slug,
          title: payload.title,
          url: payload.url,
          postPath: payload.postPath,
          files: payload.files.map((file) => file.path),
          markdown: payload.markdown,
        };
      } catch (error) {
        lastError = error;
        const conflict = step === 'ref-update' && (error.status === 409 || error.status === 422);
        if (attempt === 0 && conflict) {
          hooks.onProgress({ step: 'retry', message: '远端刚有新提交，正在重试' });
          continue;
        }
        throw error;
      }
    }
    throw lastError || new PublishError('UNKNOWN', '发布失败');
  }

  return { publish, listExistingPosts, buildPostFiles };
}

async function waitForDeploy({ httpText, siteUrl, slug, timeoutMs, intervalMs, onTick, isCancelled }) {
  const deadline = Date.now() + (timeoutMs || DEFAULTS.intervals.deployTimeout);
  const gap = intervalMs || DEFAULTS.intervals.deployPoll;
  const base = String(siteUrl).replace(/\/+$/, '');
  let attempts = 0;
  while (Date.now() < deadline) {
    if (isCancelled && isCancelled()) return { deployed: false, cancelled: true, attempts };
    attempts += 1;
    try {
      const rss = await httpText(`${base}/rss.xml?t=${Date.now()}`);
      if (String(rss).includes(`/${slug}/`)) {
        return { deployed: true, attempts };
      }
    } catch (error) {
      // 部署过程中 RSS 可能短暂不可用，继续轮询
    }
    if (onTick) onTick(attempts);
    await sleep(gap);
  }
  return { deployed: false, timeout: true, attempts };
}

module.exports = {
  PublishError,
  validateDraft,
  buildPostFiles,
  createPublisher,
  waitForDeploy,
  quoteYaml,
  normalizeTags,
  extensionFor,
};
