import { AGENTS, CONSENSUS_AGENT } from './agents';
import { callAgent } from './providers';
import {
  postComment,
  transitionLabel,
  addLabel,
  removeLabel,
  getIssue,
  getIssueComments,
  type GitHubIssue,
  type GitHubComment,
} from './github';

// ── Prompt builders ────────────────────────────────────────────────────────

function buildProposalPrompt(issue: GitHubIssue): string {
  return `\
A new proposal has been opened on the Crucible project. Review it and share your perspective.

**Issue #${issue.number}: ${issue.title}**

${issue.body ?? '(no description provided)'}

---
Respond as your persona. Be substantive. ~200–300 words.`;
}

function buildFollowUpPrompt(issue: GitHubIssue, priorComments: GitHubComment[]): string {
  const thread = priorComments
    .map(c => `**${c.user.login}** (${new Date(c.created_at).toLocaleDateString()}):\n${c.body}`)
    .join('\n\n---\n\n');

  return `\
There is ongoing debate on a Crucible proposal. Read the thread and add your perspective. \
You can respond to specific points others have made.

**Issue #${issue.number}: ${issue.title}**

${issue.body ?? '(no description provided)'}

**Thread so far:**

${thread}

---
Add your take. You can agree, disagree, or introduce a new angle. ~200–300 words.`;
}

function buildConsensusPrompt(issue: GitHubIssue, comments: GitHubComment[]): string {
  const thread = comments
    .map(c => `**${c.user.login}**:\n${c.body}`)
    .join('\n\n---\n\n');

  return `\
48 hours have passed. Summarize the debate and call the verdict.

**Issue #${issue.number}: ${issue.title}**

**Original proposal:**
${issue.body ?? '(no description provided)'}

**Full debate thread:**

${thread}`;
}

// ── Staggered posting ─────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call all agents in parallel, then post their responses staggered
 * so the thread reads as a natural conversation rather than a wall of
 * simultaneous comments.
 */
async function postAgentResponses(
  issueNumber: number,
  prompt: string,
  agentSubset = AGENTS,
): Promise<void> {
  console.log(`[dispatch] Calling ${agentSubset.length} agents for issue #${issueNumber}…`);

  // Call all LLMs in parallel — faster than serial
  const results = await Promise.allSettled(
    agentSubset.map(agent => callAgent(agent, prompt).then(text => ({ agent, text }))),
  );

  // Post responses with a small stagger so GitHub shows them sequentially
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      // Log full error so it shows in Vercel function logs
      const err = result.reason as Error;
      console.error(`[dispatch] Agent ${agentSubset[i].name} (${agentSubset[i].provider}) FAILED: ${err?.message ?? err}`);
      continue;
    }
    await postComment(issueNumber, result.value.text);
    if (i < results.length - 1) await delay(800); // 0.8s between posts
  }
}

// ── Event handlers ────────────────────────────────────────────────────────

/**
 * Called when a new issue is opened with the `proposed` label.
 * All six agents weigh in; label transitions proposed → debating.
 */
export async function handleNewProposal(issue: GitHubIssue): Promise<void> {
  // Idempotency guard — fetch *current* labels from GitHub (not the stale
  // webhook payload) in case this event was redelivered after agents already ran
  const freshIssue = await getIssue(issue.number);
  const currentLabels = freshIssue.labels.map(l => l.name);
  if (currentLabels.includes('debating')) {
    console.log(`[dispatch] Issue #${issue.number} already debating — skipping`);
    return;
  }

  console.log(`[dispatch] New proposal: #${issue.number} "${issue.title}"`);

  const prompt = buildProposalPrompt(issue);
  await postAgentResponses(issue.number, prompt);
  await transitionLabel(issue.number, 'proposed', 'debating');
}

/**
 * Called when a human posts a follow-up comment on a debating issue.
 * Two agents respond (rotating through the roster so each gets equal airtime).
 */
export async function handleFollowUp(
  issue: GitHubIssue,
  comments: GitHubComment[],
): Promise<void> {
  console.log(`[dispatch] Follow-up on #${issue.number} — picking 2 agents to respond`);

  // Rotate which pair of agents responds based on comment count
  const offset = (comments.length - 1) % AGENTS.length;
  const respondents = [AGENTS[offset], AGENTS[(offset + 3) % AGENTS.length]];

  const prompt = buildFollowUpPrompt(issue, comments);
  await postAgentResponses(issue.number, prompt, respondents);
}

/**
 * Called by the GitHub Actions consensus cron after the 48hr debate window.
 * Consensus Agent reads the full thread and calls a verdict.
 */
export async function handleConsensus(
  issue: GitHubIssue,
  comments: GitHubComment[],
): Promise<void> {
  console.log(`[dispatch] Calling consensus on #${issue.number}`);

  const prompt = buildConsensusPrompt(issue, comments);
  const summary = await callAgent(CONSENSUS_AGENT, prompt);
  await postComment(issue.number, summary);

  // Parse verdict from the summary text
  const reached = summary.includes('CONSENSUS REACHED') || summary.includes('✅');
  if (reached) {
    await transitionLabel(issue.number, 'debating', 'consensus-reached');
  } else {
    await transitionLabel(issue.number, 'debating', 'needs-rework');
  }
}

// ── Bot username detection ────────────────────────────────────────────────
// Prevents the orchestrator from responding to its own comments.

const BOT_LOGINS = new Set([
  'github-actions[bot]',
  'dependabot[bot]',
]);

export function isHumanComment(login: string): boolean {
  return !BOT_LOGINS.has(login) && !login.endsWith('[bot]');
}
