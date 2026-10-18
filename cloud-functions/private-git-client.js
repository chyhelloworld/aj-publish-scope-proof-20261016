import { sign } from 'node:crypto';

const REPO = 'chyhelloworld/aj-private-content-proof-20261018';
const REPO_ID = 1423846225;
const OWNER_ID = 103913273;
const BRANCH = 'codex/private-content-proof';
export class GitProbeError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
  }
}
const insist = (condition, message) => {
  if (!condition) throw new GitProbeError(message);
};
const minimal = (permissions) =>
  permissions?.contents === 'write' &&
  permissions?.metadata === 'read' &&
  Object.keys(permissions).every((key) =>
    ['contents', 'metadata'].includes(key),
  );

function privateKeyValue(env) {
  if (env.CONTENT_APP_PRIVATE_KEY) return env.CONTENT_APP_PRIVATE_KEY;
  const parts = [
    env.CONTENT_APP_PRIVATE_KEY_1,
    env.CONTENT_APP_PRIVATE_KEY_2,
    env.CONTENT_APP_PRIVATE_KEY_3,
  ];
  return parts.every((part) => typeof part === 'string' && part.length > 0)
    ? parts.join('')
    : '';
}

export function contentConfiguration(env) {
  return {
    repository: REPO,
    repositoryId: REPO_ID,
    branch: BRANCH,
    configured: Boolean(
      privateKeyValue(env) &&
      /^\d+$/.test(env.CONTENT_APP_ID || '') &&
      /^\d+$/.test(env.CONTENT_APP_INSTALLATION_ID || '') &&
      env.CONTENT_REPOSITORY === REPO &&
      Number(env.CONTENT_REPOSITORY_ID) === REPO_ID &&
      env.CONTENT_BRANCH === BRANCH,
    ),
  };
}

export function appJwt(env, now = Date.now()) {
  // The provider's single-line environment editor rejects PEM header spaces.
  const keyValue = privateKeyValue(env);
  const privateKey = keyValue.startsWith('-----BEGIN')
    ? keyValue.replace(/\\n/g, '\n')
    : Buffer.from(keyValue, 'base64').toString('utf8');
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const seconds = Math.floor(now / 1000);
  const unsigned =
    encode({ alg: 'RS256', typ: 'JWT' }) +
    '.' +
    encode({ iss: env.CONTENT_APP_ID, iat: seconds - 60, exp: seconds + 540 });
  return (
    unsigned +
    '.' +
    sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')
  );
}

export async function openPrivateGit({
  env,
  fetchImpl = fetch,
  now = Date.now,
}) {
  insist(
    contentConfiguration(env).configured,
    '私有 Git 测试凭据尚未配置完整。',
  );
  async function request(endpoint, token, method = 'GET', body) {
    let response;
    try {
      response = await fetchImpl('https://api.github.com' + endpoint, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'AdventureJournalContentProbe',
          'X-GitHub-Api-Version': '2026-03-10',
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new GitProbeError('GitHub 请求结果待确认；请勿重复提交同一步骤。');
    }
    if (!response.ok) {
      await response.arrayBuffer();
      return { status: response.status, data: null };
    }
    try {
      return { status: response.status, data: await response.json() };
    } catch {
      throw new GitProbeError('GitHub 返回不完整；结果待确认。');
    }
  }
  const jwt = appJwt(env, now());
  const installation = await request(
    `/app/installations/${env.CONTENT_APP_INSTALLATION_ID}`,
    jwt,
  );
  const info = installation.data;
  insist(
    installation.status === 200 &&
      info?.id === Number(env.CONTENT_APP_INSTALLATION_ID) &&
      info?.app_id === Number(env.CONTENT_APP_ID) &&
      info?.account?.id === OWNER_ID &&
      info?.repository_selection === 'selected' &&
      minimal(info?.permissions),
    'App 安装身份、选择方式或权限不符合已授权配置。',
  );
  const issued = await request(
    `/app/installations/${env.CONTENT_APP_INSTALLATION_ID}/access_tokens`,
    jwt,
    'POST',
    {
      repository_ids: [REPO_ID],
      permissions: { contents: 'write', metadata: 'read' },
    },
  );
  insist(
    issued.status === 201 &&
      issued.data?.token &&
      minimal(issued.data?.permissions),
    '无法取得指定单仓库的最小权限令牌。',
  );
  const token = issued.data.token;
  const repositories = await request(
    '/installation/repositories?per_page=100',
    token,
  );
  const target = repositories.data?.repositories?.[0];
  insist(
    repositories.status === 200 &&
      repositories.data.total_count === 1 &&
      repositories.data.repositories.length === 1 &&
      target?.id === REPO_ID &&
      target.full_name === REPO &&
      target.private === true &&
      target.owner?.id === OWNER_ID,
    '令牌仓库范围或私有状态检查失败。',
  );
  const denied = await request(
    '/repos/chyhelloworld/adventure-journal-blog',
    token,
  );
  insist(denied.status === 404, '正式私有库访问拒绝检查未通过，已停止测试。');
  const evidence = {
    repository: REPO,
    repositoryId: REPO_ID,
    branch: BRANCH,
    tokenRepositoryCount: 1,
    effectivePermissions: { contents: 'write', metadata: 'read' },
    productionPrivateRepositoryStatus: denied.status,
    tokenExpiresAt: issued.data.expires_at,
    installationSelection: 'selected',
    note: 'Installation repository selection is separately verified in GitHub UI; this list proves the narrowed token scope.',
  };
  function contentPath(file) {
    insist(
      /^(working|published|recovered|recovered-published)\/probe-[a-f0-9-]{36}\.md$/.test(
        file,
      ) || /^articles\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(file),
      '文章文件路径无效。',
    );
    return `/repos/${REPO}/contents/${file}`;
  }
  return {
    evidence,
    async listArticles() {
      const result = await request(
        `/repos/${REPO}/contents/articles?ref=${encodeURIComponent(BRANCH)}`,
        token,
      );
      if (result.status === 404) return [];
      insist(
        result.status === 200 && Array.isArray(result.data),
        '暂时无法读取文章列表。',
      );
      insist(
        result.data.length < 1000,
        '文章目录达到接口列表上限，请先调整目录后继续。',
      );
      return result.data
        .filter(
          (item) =>
            item.type === 'file' &&
            /^articles\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(item.path),
        )
        .map((item) => item.path);
    },
    async read(file) {
      const result = await request(
        `${contentPath(file)}?ref=${encodeURIComponent(BRANCH)}`,
        token,
      );
      if (result.status === 404) return null;
      insist(
        result.status === 200 &&
          result.data?.type === 'file' &&
          /^[a-f0-9]{40}$/.test(result.data.sha),
        'Markdown 未完整读回。',
      );
      const blob =
        result.data.encoding === 'base64'
          ? result
          : await request(`/repos/${REPO}/git/blobs/${result.data.sha}`, token);
      insist(
        blob.status === 200 && blob.data?.encoding === 'base64',
        'Markdown 文件内容不可用。',
      );
      return {
        sha: result.data.sha,
        raw: Buffer.from(blob.data.content, 'base64').toString('utf8'),
      };
    },
    async write(file, raw, sha) {
      const result = await request(contentPath(file), token, 'PUT', {
        branch: BRANCH,
        message: 'Synthetic private content proof',
        content: Buffer.from(raw).toString('base64'),
        ...(sha ? { sha } : {}),
      });
      if ([200, 201].includes(result.status))
        insist(
          result.data?.content?.sha && result.data?.commit?.sha,
          '保存回执缺少版本，结果待确认。',
        );
      return {
        status: result.status,
        sha: result.data?.content?.sha,
        commit: result.data?.commit?.sha,
      };
    },
  };
}
