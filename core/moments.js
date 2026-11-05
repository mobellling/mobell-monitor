'use strict';

const { b64encode, sleep } = require('./util');
const { DEFAULTS } = require('./config');
const { PublishError, quoteYaml, extensionFor } = require('./publish');
const { parseRepoContents } = require('./parse');

function toIso(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new PublishError('INVALID_DATE', '动态时间无效');
  return date.toISOString();
}

/** Filename / URL id, second precision in UTC: 20261105123000 */
function momentId(date) {
  return String(toIso(date)).replace(/\D/g, '').slice(0, 14);
}

function charLength(value) {
  return Array.from(String(value == null ? '' : value)).length;
}

function validateMoment(draft) {
  const errors = {};
  const text = String(draft.text || '').replace(/\r\n?/g, '\n').trim();
  const images = Array.isArray(draft.images) ? draft.images : [];

  if (!text) errors.text = '请写点什么再发布';
  else if (charLength(text) > DEFAULTS.moments.maxText) {
    errors.text = `动态最多 ${DEFAULTS.moments.maxText} 字`;
  }
  if (images.length > DEFAULTS.moments.maxImages) {
    errors.images = `最多上传 ${DEFAULTS.moments.maxImages} 张图片`;
  }
  images.forEach((image, index) => {
    if (!image || !image.base64) errors.images = `第 ${index + 1} 张图片读取失败`;
    else if (!extensionFor(image.mime, image.name)) errors.images = `第 ${index + 1} 张图片格式不支持`;
    else if (Number(image.size) > DEFAULTS.moments.maxImageBytes) {
      errors.images = `第 ${index + 1} 张图片超过 5MB`;
    }
  });
  if (draft.date) {
    try {
      toIso(draft.date);
    } catch (error) {
      errors.date = '动态时间无效';
    }
  }
  return { errors, text, images };
}

function buildMomentFiles(draft, options) {
  const opts = Object.assign({}, DEFAULTS.moments, options || {});
  const validated = validateMoment(draft);
  if (Object.keys(validated.errors).length) {
    throw new PublishError('VALIDATION', '动态校验未通过', { fields: validated.errors });
  }
  const { text, images } = validated;
  const date = toIso(draft.date);
  let id = String(draft.id || momentId(date));
  if (!/^\d{14}(-\d+)?$/.test(id)) id = momentId(date);

  const files = [];
  const imagePaths = [];
  images.forEach((image, index) => {
    const ext = extensionFor(image.mime, image.name) || 'jpg';
    const path = `${opts.imageDir}/${id}-${index + 1}.${ext}`;
    files.push({ path, base64: String(image.base64).replace(/^data:[^;]+;base64,/, ''), binary: true });
    imagePaths.push(`/${path.replace(/^public\//, '')}`);
  });

  const lines = ['---', `date: ${date}`];
  if (imagePaths.length) {
    lines.push('images:');
    for (const imagePath of imagePaths) lines.push(`  - ${quoteYaml(imagePath)}`);
  }
  lines.push('---', '', text.trimEnd(), '');
  const markdown = lines.join('\n');
  const mdPath = `${opts.dir}/${id}.md`;
  files.unshift({ path: mdPath, base64: b64encode(markdown), binary: false, markdown });

  const siteUrl = String((options && options.siteUrl) || DEFAULTS.siteUrl).replace(/\/+$/, '');
  return {
    id,
    markdown,
    files,
    date,
    text,
    url: `${siteUrl}/moments/${id}/`,
    commitMessage: `moments: 添加动态 ${date.slice(0, 10)}`,
  };
}

function createMomentPublisher({ transport, config }) {
  const opts = Object.assign({}, DEFAULTS.moments, (config && config.moments) || {});
  if (!transport || typeof transport.request !== 'function') {
    throw new Error('createMomentPublisher 需要 transport.request');
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

  async function existingIds() {
    try {
      const data = await request('GET', `/repos/${owner}/${repo}/contents/${opts.dir}?ref=${encodeURIComponent(branch)}`);
      return parseRepoContents(data).map((file) => String(file.name).replace(/\.md$/i, '')).filter(Boolean);
    } catch (error) {
      if (error.status === 404) return [];
      throw error;
    }
  }

  async function publish(draft, handlers) {
    const hooks = Object.assign({ onProgress: () => {} }, handlers || {});
    let payload = buildMomentFiles(draft, opts);
    hooks.onProgress({ step: 'validate', message: '动态校验通过' });

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let step = 'collision';
      try {
        const taken = await existingIds();
        if (taken.includes(payload.id)) {
          let suffix = 2;
          while (taken.includes(`${payload.id}-${suffix}`)) suffix += 1;
          payload = buildMomentFiles(Object.assign({}, draft, { id: `${payload.id}-${suffix}` }), opts);
        }
        hooks.onProgress({ step: 'collision', message: '时间戳可用' });

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
        hooks.onProgress({ step: 'ref-update', message: `更新 ${branch}` });
        await request('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
          sha: commit.sha,
          force: false,
        });

        hooks.onProgress({ step: 'done', message: '提交成功' });
        return {
          id: payload.id,
          date: payload.date,
          text: payload.text,
          commitSha: commit.sha,
          commitUrl: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
          url: payload.url,
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
    throw lastError || new PublishError('UNKNOWN', '发布动态失败');
  }

  return { publish, existingIds, buildMomentFiles };
}

async function waitForMomentDeploy({ httpText, siteUrl, id, timeoutMs, intervalMs, onTick, isCancelled }) {
  const deadline = Date.now() + (timeoutMs || DEFAULTS.intervals.deployTimeout);
  const gap = intervalMs || DEFAULTS.intervals.deployPoll;
  const base = String(siteUrl).replace(/\/+$/, '');
  let attempts = 0;
  while (Date.now() < deadline) {
    if (isCancelled && isCancelled()) return { deployed: false, cancelled: true, attempts };
    attempts += 1;
    try {
      const html = await httpText(`${base}/moments/${id}/?t=${Date.now()}`);
      if (String(html).includes('giscus') || String(html).includes('返回动态')) {
        return { deployed: true, attempts };
      }
    } catch (error) {
      // 部署期间页面可能短暂 404，继续等待
    }
    if (onTick) onTick(attempts);
    await sleep(gap);
  }
  return { deployed: false, timeout: true, attempts };
}

module.exports = {
  validateMoment,
  buildMomentFiles,
  createMomentPublisher,
  waitForMomentDeploy,
  momentId,
};
