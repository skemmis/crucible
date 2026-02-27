/**
 * Recovery script: call the PM Round 2 verdict for an issue where
 * Round 2 agents already posted but the PM timed out.
 *
 * Usage:  ISSUE_NUMBER=36 npx tsx scripts/recover-round2.ts
 */

import { getIssue, getIssueComments, postComment, addLabel } from '../src/github';
import { callAgent } from '../src/providers';
import { PM_AGENT } from '../src/agents';

async function main() {
  const issueNumber = parseInt(process.env.ISSUE_NUMBER ?? '0', 10);
  if (!issueNumber) throw new Error('Set ISSUE_NUMBER env var');

  console.log(`[recover-round2] Fetching issue #${issueNumber}…`);
  const [issue, comments] = await Promise.all([
    getIssue(issueNumber),
    getIssueComments(issueNumber),
  ]);

  const thread = comments.map(c => c.body).join('\n\n---\n\n');
  const prompt = `\
You are synthesising a two-round debate about a Crucible feature proposal.

**Issue #${issue.number}: ${issue.title}**

${issue.body ?? '(no description)'}

**Full debate thread:**

${thread}

If you call ✅ PRELIMINARY CONSENSUS and the debate identified future phases or follow-up \
work that should NOT be implemented now, list each as a deferred item in EXACTLY this format \
at the end of your response (omit the block entirely if there are no deferred items):

DEFERRED_ITEMS_START
- <concise issue title> || <1-2 sentence description of what to build and why it was deferred>
DEFERRED_ITEMS_END`;

  console.log(`[recover-round2] ${comments.length} comments found. Calling PM…`);
  const verdict = await callAgent(PM_AGENT, prompt);

  console.log(`[recover-round2] Posting PM verdict (${verdict.length} chars)…`);
  await postComment(issueNumber, verdict);
  await addLabel(issueNumber, 'round-2-done');
  console.log(`[recover-round2] Done — round-2-done label added to #${issueNumber}`);
}

main().catch(err => { console.error(err); process.exit(1); });
