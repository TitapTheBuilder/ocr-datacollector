const fs = require('fs');
const path = require('path');
const db = require('./database');

const GITHUB_API = 'https://api.github.com';

/**
 * Mask GitHub Personal Access Token for safe UI display
 */
function maskToken(token) {
  if (!token) return '';
  const trimmed = token.trim();
  if (trimmed.length <= 8) return '********';
  return trimmed.slice(0, 4) + '****' + trimmed.slice(-4);
}

/**
 * Parse owner and repository from input
 * Supports: "owner/repo", "https://github.com/owner/repo", "github.com/owner/repo.git"
 */
function parseRepo(repoInput) {
  if (!repoInput || typeof repoInput !== 'string') {
    throw new Error('نام ریپازیتوری وارد نشده است.');
  }
  let cleaned = repoInput.trim();
  if (cleaned.endsWith('.git')) cleaned = cleaned.slice(0, -4);
  const match = cleaned.match(/(?:github\.com\/)?([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error('فرمت ریپازیتوری نامعتبر است. نمونه صحیح: owner/repo (مثال: username/persian-ocr-dataset)');
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * Standard GitHub API request headers
 */
function getHeaders(token) {
  return {
    'Authorization': `Bearer ${token.trim()}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Persian-OCR-DataCollector',
  };
}

/**
 * Get current GitHub configuration status from database
 */
function getConfigStatus() {
  const token = db.getSetting('github_token') || '';
  const repo = db.getSetting('github_repo') || '';
  const branch = db.getSetting('github_branch') || 'main';
  const repoPath = db.getSetting('github_path') || '';

  return {
    isConfigured: !!(token && repo),
    hasToken: !!token,
    maskedToken: maskToken(token),
    repo,
    branch,
    path: repoPath,
  };
}

/**
 * Test connection and permissions to the specified GitHub repository
 */
async function testConnection({ token, repo, branch = 'main' }) {
  if (!token || !token.trim()) {
    throw new Error('توکن گیت‌هاب (Personal Access Token) الزامی است.');
  }
  if (!repo || !repo.trim()) {
    throw new Error('نام ریپازیتوری الزامی است.');
  }

  const { owner, repo: repoName } = parseRepo(repo);
  const headers = getHeaders(token);

  let repoRes;
  try {
    repoRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}`, { headers });
  } catch (err) {
    throw new Error(`خطای شبکه در ارتباط با گیت‌هاب: ${err.message}`);
  }

  if (!repoRes.ok) {
    if (repoRes.status === 401) {
      throw new Error('توکن گیت‌هاب نامعتبر یا منقضی شده است (خطای ۴۰۱).');
    }
    if (repoRes.status === 404) {
      throw new Error(`ریپازیتوری «${owner}/${repoName}» یافت نشد یا توکن شما دسترسی به آن ندارد (خطای ۴۰۴).`);
    }
    const errData = await repoRes.json().catch(() => ({}));
    throw new Error(errData.message || `خطا در دریافت اطلاعات ریپازیتوری (${repoRes.status})`);
  }

  const repoData = await repoRes.json();
  const defaultBranch = repoData.default_branch || 'main';
  const targetBranch = branch ? branch.trim() : defaultBranch;

  let branchExists = false;
  if (!repoData.empty) {
    try {
      const branchRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/branches/${encodeURIComponent(targetBranch)}`, { headers });
      if (branchRes.ok) {
        branchExists = true;
      }
    } catch (_) {}
  }

  return {
    success: true,
    repoFullName: repoData.full_name,
    isPrivate: repoData.private,
    defaultBranch,
    targetBranch,
    branchExists,
    isEmpty: !!repoData.empty,
    canPush: repoData.permissions ? repoData.permissions.push : undefined,
  };
}

/**
 * Commit dataset files into GitHub using Git Data API (Blobs -> Tree -> Commit -> Ref)
 */
async function commitDataset({ token, repo, branch = 'main', targetPath = '', files = [], message = '' }) {
  if (!token || !token.trim()) {
    throw new Error('توکن گیت‌هاب الزامی است.');
  }
  if (!repo || !repo.trim()) {
    throw new Error('نام ریپازیتوری الزامی است.');
  }
  if (!files || files.length === 0) {
    throw new Error('هیچ فایلی برای کامیت ارسال نشده است.');
  }

  const { owner, repo: repoName } = parseRepo(repo);
  const headers = getHeaders(token);

  // 1. Fetch repo details
  const repoRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}`, { headers });
  if (!repoRes.ok) {
    if (repoRes.status === 401) throw new Error('توکن گیت‌هاب نامعتبر یا منقضی شده است.');
    if (repoRes.status === 404) throw new Error(`ریپازیتوری ${owner}/${repoName} یافت نشد.`);
    throw new Error(`خطا در بررسی ریپازیتوری: ${repoRes.statusText}`);
  }
  const repoData = await repoRes.json();
  const targetBranch = (branch && branch.trim()) ? branch.trim() : (repoData.default_branch || 'main');

  // 2. Fetch existing commit SHA & tree SHA for branch if exists
  let baseCommitSha = null;
  let baseTreeSha = null;
  let refExists = false;

  const refRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/ref/heads/${encodeURIComponent(targetBranch)}`, { headers });
  if (refRes.ok) {
    refExists = true;
    const refData = await refRes.json();
    baseCommitSha = refData.object.sha;

    const commitRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/commits/${baseCommitSha}`, { headers });
    if (commitRes.ok) {
      const commitData = await commitRes.json();
      baseTreeSha = commitData.tree.sha;
    }
  } else if (!repoData.empty && repoData.default_branch) {
    // If target branch doesn't exist yet, try to branch off default branch
    const defaultRefRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/ref/heads/${encodeURIComponent(repoData.default_branch)}`, { headers });
    if (defaultRefRes.ok) {
      const defaultRefData = await defaultRefRes.json();
      baseCommitSha = defaultRefData.object.sha;
      const commitRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/commits/${baseCommitSha}`, { headers });
      if (commitRes.ok) {
        const commitData = await commitRes.json();
        baseTreeSha = commitData.tree.sha;
      }
    }
  }

  // 3. Upload blobs with controlled concurrency
  const treeItems = [];
  const concurrency = 5;

  async function uploadSingleBlob(file) {
    let contentBase64;
    let encoding = 'base64';

    if (file.diskPath) {
      const fileBuffer = fs.readFileSync(file.diskPath);
      contentBase64 = fileBuffer.toString('base64');
    } else if (file.isBinary || Buffer.isBuffer(file.content)) {
      contentBase64 = Buffer.isBuffer(file.content)
        ? file.content.toString('base64')
        : Buffer.from(file.content).toString('base64');
    } else {
      contentBase64 = Buffer.from(String(file.content), 'utf-8').toString('base64');
    }

    const blobRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/blobs`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: contentBase64, encoding }),
    });

    if (!blobRes.ok) {
      const err = await blobRes.json().catch(() => ({}));
      throw new Error(`خطا در آپلود ${file.path}: ${err.message || blobRes.statusText}`);
    }

    const blobData = await blobRes.json();
    return {
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: blobData.sha,
    };
  }

  for (let i = 0; i < files.length; i += concurrency) {
    const chunk = files.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map(uploadSingleBlob));
    treeItems.push(...results);
  }

  // 4. Create Git Tree
  const treeBody = { tree: treeItems };
  if (baseTreeSha) {
    treeBody.base_tree = baseTreeSha;
  }

  const treeRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/trees`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(treeBody),
  });

  if (!treeRes.ok) {
    const err = await treeRes.json().catch(() => ({}));
    throw new Error(`خطا در ایجاد ساختار درختی گیت (Tree): ${err.message || treeRes.statusText}`);
  }
  const newTree = await treeRes.json();

  // 5. Create Commit
  const commitMsg = message || `Update Persian OCR dataset: ${files.length} files`;
  const commitBody = {
    message: commitMsg,
    tree: newTree.sha,
    parents: baseCommitSha ? [baseCommitSha] : [],
  };

  const commitRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/commits`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(commitBody),
  });

  if (!commitRes.ok) {
    const err = await commitRes.json().catch(() => ({}));
    throw new Error(`خطا در ثبت کامیت (Commit): ${err.message || commitRes.statusText}`);
  }
  const newCommit = await commitRes.json();

  // 6. Update or create branch reference
  if (refExists) {
    const updateRefRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/refs/heads/${encodeURIComponent(targetBranch)}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommit.sha, force: true }),
    });
    if (!updateRefRes.ok) {
      const err = await updateRefRes.json().catch(() => ({}));
      throw new Error(`خطا در به‌روزرسانی برنچ ${targetBranch}: ${err.message || updateRefRes.statusText}`);
    }
  } else {
    const createRefRes = await fetch(`${GITHUB_API}/repos/${owner}/${repoName}/git/refs`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${targetBranch}`, sha: newCommit.sha }),
    });
    if (!createRefRes.ok) {
      const err = await createRefRes.json().catch(() => ({}));
      throw new Error(`خطا در ایجاد برنچ ${targetBranch}: ${err.message || createRefRes.statusText}`);
    }
  }

  return {
    success: true,
    commitSha: newCommit.sha,
    commitUrl: `https://github.com/${owner}/${repoName}/commit/${newCommit.sha}`,
    branch: targetBranch,
    filesCommitted: files.length,
  };
}

module.exports = {
  parseRepo,
  maskToken,
  getConfigStatus,
  testConnection,
  commitDataset,
};
