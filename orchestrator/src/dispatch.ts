import { AGENTS, CONSENSUS_AGENT, PM_AGENT } from './agents';
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

function buildPMRound1Prompt(issue: GitHubIssue, round1Comments: GitHubComment[]): string {
  const thread = round1Comments
    .map(c => `**${c.user.login}**:\n${c.body}`)
    .join('\n\n---\n\n');

  return `\
Round 1 of debate on a Crucible proposal has just completed. You are the Product Manager.

**Issue #${issue.number}: ${issue.title}**

**Original proposal:**
${issue.body ?? '(no description provided)'}

**Round 1 comments:**

${thread}

---
Write your Round 1 synthesis: identify where experts agree, name the 1–2 real cruxes that remain, \
and pose a sharp focused question for the Round 2 agents to answer. 150–200 words.`;
}

function buildRound2AgentPrompt(issue: GitHubIssue, allComments: GitHubComment[]): string {
  const thread = allComments
    .map(c => `**${c.user.login}** (${new Date(c.created_at).toLocaleDateString()}):\n${c.body}`)
    .join('\n\n---\n\n');

  return `\
This is Round 2 of debate on a Crucible proposal. Read the full thread (Round 1 + PM synthesis), \
then give your updated take — specifically address the crux question the PM identified.

**Issue #${issue.number}: ${issue.title}**

${issue.body ?? '(no description provided)'}

**Full thread so far:**

${thread}

---
Respond as your persona. Address the PM's framing question directly. ~200–300 words.`;
}

function buildPMRound2Prompt(issue: GitHubIssue, allComments: GitHubComment[]): string {
  const thread = allComments
    .map(c => `**${c.user.login}**:\n${c.body}`)
    .join('\n\n---\n\n');

  return `\
Round 2 of debate on a Crucible proposal has completed. You are the Product Manager.

**Issue #${issue.number}: ${issue.title}**

**Original proposal:**
${issue.body ?? '(no description provided)'}

**Full debate thread (Round 1 + Round 2):**

${thread}

---
Write your Round 2 synthesis: briefly restate the cruxes, say how Round 2 resolved them, \
then call a verdict:
- ✅ PRELIMINARY CONSENSUS — state clearly what to build
- 🔄 NEEDS MORE DEBATE — state exactly what is still unresolved

200–250 words.`;
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
 *
 * @param skipLateGuard - if true, skip the late idempotency guard (Round 2 uses
 *   its own top-level guards in handleRound2 instead)
 * @returns true if agents were posted, false if the late guard fired and posting was skipped
 */
async function postAgentResponses(
  issueNumber: number,
  prompt: string,
  agentSubset = AGENTS,
  skipLateGuard = false,
): Promise<boolean> {
  console.log(`[dispatch] Calling ${agentSubset.length} agents for issue #${issueNumber}…`);

  // Call all LLMs in parallel — faster than serial
  const results = await Promise.allSettled(
    agentSubset.map(agent => callAgent(agent, prompt).then(text => ({ agent, text }))),
  );

  if (!skipLateGuard) {
    // Late idempotency guard: re-check for agent comments AFTER LLM calls return
    // but BEFORE posting. Parallel webhook invocations all reach here with 0
    // comments, but by the time the slowest one finishes, the faster one may have
    // already started posting. Only applies to Round 1 — Round 2 has its own
    // idempotency guards at the top of handleRound2().
    const lateComments = await getIssueComments(issueNumber);
    if (lateComments.some(c => isAgentComment(c.body))) {
      console.log(`[dispatch] Issue #${issueNumber} — late guard triggered, skipping`);
      return false;
    }
  }

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

  return true;
}

// ── Event handlers ────────────────────────────────────────────────────────

/**
 * Called when a new issue is opened with the `proposed` label.
 * All six agents weigh in (Round 1); PM synthesizes; round-1-done label added.
 * Label transitions: proposed → debating
 */
export async function handleNewProposal(issue: GitHubIssue): Promise<void> {
  // Use the label transition as a distributed lock — do it FIRST before calling
  // any agents. If the `proposed` label is already gone (another request beat us
  // here), removeLabel returns silently and addLabel will just be a no-op on
  // `debating`. We detect this by re-checking after the transition attempt.
  await transitionLabel(issue.number, 'proposed', 'debating');

  // Confirm we actually own this run — re-fetch current labels
  const freshIssue = await getIssue(issue.number);
  const currentLabels = freshIssue.labels.map(l => l.name);
  if (!currentLabels.includes('debating')) {
    console.log(`[dispatch] Issue #${issue.number} — transition failed, skipping`);
    return;
  }

  // Guard against duplicate runs: if there are already agent comments, skip
  const existingComments = await getIssueComments(issue.number);
  if (existingComments.some(c => isAgentComment(c.body))) {
    console.log(`[dispatch] Issue #${issue.number} already has agent comments — skipping`);
    return;
  }

  console.log(`[dispatch] New proposal: #${issue.number} "${issue.title}" — Round 1`);

  // ── Round 1: all six agents respond ──────────────────────────────────────
  const round1Prompt = buildProposalPrompt(issue);
  const round1Posted = await postAgentResponses(issue.number, round1Prompt);
  if (!round1Posted) {
    console.log(`[dispatch] Issue #${issue.number} — Round 1 agents already posted, skipping PM synthesis`);
    return;
  }

  // ── PM synthesis: frame Round 2 question ─────────────────────────────────
  // Re-fetch comments to include what was just posted
  const round1Comments = await getIssueComments(issue.number);
  const pmRound1Prompt = buildPMRound1Prompt(issue, round1Comments);
  console.log(`[dispatch] PM synthesizing Round 1 for issue #${issue.number}…`);
  const pmSynthesis = await callAgent(PM_AGENT, pmRound1Prompt);
  await postComment(issue.number, pmSynthesis);

  // ── Signal Round 2 via label ─────────────────────────────────────────────
  await addLabel(issue.number, 'round-1-done');
  console.log(`[dispatch] Issue #${issue.number} — round-1-done label added`);
}

/**
 * Called when the `round-1-done` label is added to a debating issue.
 * All six agents respond to Round 2; PM calls preliminary verdict.
 * Label transitions: round-1-done → round-2-done
 */
export async function handleRound2(issue: GitHubIssue): Promise<void> {
  // Idempotency guard: only proceed if round-2-done is NOT already set
  const freshIssue = await getIssue(issue.number);
  const currentLabels = freshIssue.labels.map(l => l.name);
  if (currentLabels.includes('round-2-done')) {
    console.log(`[dispatch] Issue #${issue.number} — round-2-done already set, skipping`);
    return;
  }

  // Check if Round 2 comments already exist (PM Round 1 header is the sentinel)
  const existingComments = await getIssueComments(issue.number);
  const pmHeader = '**📋 Product Manager**';
  const pmCommentCount = existingComments.filter(c => c.body.trimStart().startsWith(pmHeader)).length;
  if (pmCommentCount >= 2) {
    // Two PM comments means Round 2 already ran
    console.log(`[dispatch] Issue #${issue.number} — Round 2 already ran (${pmCommentCount} PM comments), skipping`);
    return;
  }

  console.log(`[dispatch] Round 2 starting for issue #${issue.number}`);

  // ── Round 2: all six agents respond seeing the full thread ────────────────
  // skipLateGuard=true because Round 1 agents already exist — the late guard
  // would incorrectly trigger. handleRound2's top-level guards (label + PM count)
  // are the idempotency mechanism for Round 2.
  const allComments = await getIssueComments(issue.number);
  const round2Prompt = buildRound2AgentPrompt(issue, allComments);
  const agentsPosted = await postAgentResponses(issue.number, round2Prompt, AGENTS, true);

  if (!agentsPosted) {
    // Shouldn't happen (handleRound2 guards prevent duplicate runs), but be safe
    console.log(`[dispatch] Issue #${issue.number} — Round 2 agents skipped, aborting PM verdict`);
    return;
  }

  // ── PM Round 2 synthesis: call preliminary verdict ────────────────────────
  const fullComments = await getIssueComments(issue.number);
  const pmRound2Prompt = buildPMRound2Prompt(issue, fullComments);
  console.log(`[dispatch] PM calling preliminary verdict for issue #${issue.number}…`);
  const pmVerdict = await callAgent(PM_AGENT, pmRound2Prompt);
  await postComment(issue.number, pmVerdict);

  // ── Signal Round 2 complete ───────────────────────────────────────────────
  await addLabel(issue.number, 'round-2-done');
  console.log(`[dispatch] Issue #${issue.number} — round-2-done label added`);
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
  await postAgentResponses(issue.number, prompt, respondents, true); // follow-ups have no strict guard
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

// ── Agent comment detection ───────────────────────────────────────────────
// Since all agent comments are posted under the repo owner's account,
// we detect them by their header signature instead of login name.
//
// LLMs sometimes vary the header (different emoji variants, trailing "(cont.)",
// round labels, etc.), so we use NAME-based matching rather than exact prefix
// matching. We require the comment to start with ** and contain a known name.

const AGENT_NAMES = [
  'Naturalist',
  'Systems Engineer',
  'Chaos Agent',
  'Game Designer',
  'SFI Fellow',
  'Evolutionary Biologist',
  'Consensus Agent',
  'Product Manager',
];

export function isAgentComment(body: string): boolean {
  const trimmed = body.trimStart();
  // All agent comments start with a bold header (**...**)
  if (!trimmed.startsWith('**')) return false;
  // Check if any known agent name appears in the first line
  const firstLine = trimmed.split('\n')[0];
  return AGENT_NAMES.some(name => firstLine.includes(name));
}

const BOT_LOGINS = new Set([
  'github-actions[bot]',
  'dependabot[bot]',
]);

export function isHumanComment(login: string, body: string): boolean {
  return !BOT_LOGINS.has(login) && !login.endsWith('[bot]') && !isAgentComment(body);
}
