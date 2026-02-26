// ── GitHub REST API helpers ────────────────────────────────────────────────
// Uses fetch + a PAT — no extra dependencies.

const GITHUB_API = 'https://api.github.com';

function headers() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    Accept: 'application/vnd.github+json',
  };
}

function repo(): string {
  const r = process.env.GITHUB_REPO;
  if (!r) throw new Error('GITHUB_REPO is not set');
  return r;
}

// ── Issues ─────────────────────────────────────────────────────────────────

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  created_at: string;
  user: { login: string };
}

export async function getIssue(issueNumber: number): Promise<GitHubIssue> {
  const res = await fetch(`${GITHUB_API}/repos/${repo()}/issues/${issueNumber}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`Failed to get issue ${issueNumber}: ${res.status}`);
  return res.json() as Promise<GitHubIssue>;
}

// ── Comments ──────────────────────────────────────────────────────────────

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
}

export async function getIssueComments(issueNumber: number): Promise<GitHubComment[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${repo()}/issues/${issueNumber}/comments?per_page=100`,
    { headers: headers() },
  );
  if (!res.ok) throw new Error(`Failed to get comments for issue ${issueNumber}: ${res.status}`);
  return res.json() as Promise<GitHubComment[]>;
}

export async function postComment(issueNumber: number, body: string): Promise<void> {
  const res = await fetch(`${GITHUB_API}/repos/${repo()}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to post comment on issue ${issueNumber}: ${res.status} ${text}`);
  }
}

// ── Labels ────────────────────────────────────────────────────────────────

export async function addLabel(issueNumber: number, label: string): Promise<void> {
  const res = await fetch(`${GITHUB_API}/repos/${repo()}/issues/${issueNumber}/labels`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ labels: [label] }),
  });
  if (!res.ok) throw new Error(`Failed to add label "${label}": ${res.status}`);
}

export async function removeLabel(issueNumber: number, label: string): Promise<void> {
  const res = await fetch(
    `${GITHUB_API}/repos/${repo()}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    { method: 'DELETE', headers: headers() },
  );
  // 404 just means label wasn't present — not an error
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to remove label "${label}": ${res.status}`);
  }
}

export async function transitionLabel(
  issueNumber: number,
  from: string,
  to: string,
): Promise<void> {
  await Promise.all([removeLabel(issueNumber, from), addLabel(issueNumber, to)]);
}

// ── File content ──────────────────────────────────────────────────────────

export interface GitHubFileContent {
  content: string;   // base64-encoded
  sha: string;
  path: string;
}

/**
 * Get a file's content and SHA from the repo (needed for upsertFile).
 * Returns null if the file does not exist.
 */
export async function getFileContent(
  path: string,
  ref = 'main',
): Promise<GitHubFileContent | null> {
  const res = await fetch(
    `${GITHUB_API}/repos/${repo()}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    { headers: headers() },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to get file ${path}: ${res.status}`);
  return res.json() as Promise<GitHubFileContent>;
}

// ── Branch management ─────────────────────────────────────────────────────

/**
 * Create a new branch from the tip of `fromBranch` (default: main).
 * If the branch already exists this is a no-op (returns silently).
 */
export async function createBranch(branchName: string, fromBranch = 'main'): Promise<void> {
  // Get the SHA of the tip of fromBranch
  const refRes = await fetch(
    `${GITHUB_API}/repos/${repo()}/git/ref/heads/${encodeURIComponent(fromBranch)}`,
    { headers: headers() },
  );
  if (!refRes.ok) throw new Error(`Failed to get ref for ${fromBranch}: ${refRes.status}`);
  const refData = await refRes.json() as { object: { sha: string } };
  const sha = refData.object.sha;

  // Create the new branch
  const createRes = await fetch(`${GITHUB_API}/repos/${repo()}/git/refs`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
  });
  if (createRes.status === 422) return; // branch already exists — no-op
  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Failed to create branch ${branchName}: ${createRes.status} ${text}`);
  }
}

/**
 * Create or update a file on a branch.
 * content should be the raw string (not base64) — this function encodes it.
 */
export async function upsertFile(
  branchName: string,
  path: string,
  content: string,
  commitMessage: string,
): Promise<void> {
  // We need the existing SHA if the file already exists
  const existing = await getFileContent(path, branchName);

  const body: Record<string, string> = {
    message: commitMessage,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: branchName,
  };
  if (existing) body.sha = existing.sha;

  const res = await fetch(
    `${GITHUB_API}/repos/${repo()}/contents/${encodeURIComponent(path)}`,
    { method: 'PUT', headers: headers(), body: JSON.stringify(body) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to upsert file ${path}: ${res.status} ${text}`);
  }
}

// ── Pull Requests ─────────────────────────────────────────────────────────

/**
 * Open a pull request from branchName → main.
 * Returns the PR URL.
 */
export async function createPR(
  branchName: string,
  title: string,
  body: string,
): Promise<string> {
  const res = await fetch(`${GITHUB_API}/repos/${repo()}/pulls`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      title,
      body,
      head: branchName,
      base: 'main',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create PR: ${res.status} ${text}`);
  }
  const pr = await res.json() as { html_url: string };
  return pr.html_url;
}

// ── Issues list (for consensus cron) ─────────────────────────────────────

export async function getIssuesByLabel(label: string): Promise<GitHubIssue[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${repo()}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=50`,
    { headers: headers() },
  );
  if (!res.ok) throw new Error(`Failed to list issues with label "${label}": ${res.status}`);
  return res.json() as Promise<GitHubIssue[]>;
}
