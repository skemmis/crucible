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

// ── Issues list (for consensus cron) ─────────────────────────────────────

export async function getIssuesByLabel(label: string): Promise<GitHubIssue[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${repo()}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=50`,
    { headers: headers() },
  );
  if (!res.ok) throw new Error(`Failed to list issues with label "${label}": ${res.status}`);
  return res.json() as Promise<GitHubIssue[]>;
}
