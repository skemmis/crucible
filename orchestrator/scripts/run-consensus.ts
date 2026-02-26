/**
 * run-consensus.ts
 *
 * Called by the GitHub Actions consensus workflow every 6 hours.
 * Finds all issues with the `debating` label that have been open
 * for more than 48 hours, and calls the Consensus Agent on each.
 */

import { getIssuesByLabel, getIssueComments } from '../src/github';
import { handleConsensus } from '../src/dispatch';

const DEBATE_WINDOW_HOURS = 48;

async function main(): Promise<void> {
  console.log('[consensus] Checking for issues past the 48hr debate window…');

  const debatingIssues = await getIssuesByLabel('debating');
  console.log(`[consensus] Found ${debatingIssues.length} issue(s) with label "debating"`);

  const now = Date.now();
  let processed = 0;

  for (const issue of debatingIssues) {
    const openedAt = new Date(issue.created_at).getTime();
    const ageHours = (now - openedAt) / (1000 * 60 * 60);

    if (ageHours < DEBATE_WINDOW_HOURS) {
      console.log(
        `[consensus] Issue #${issue.number} is only ${ageHours.toFixed(1)}h old — skipping`,
      );
      continue;
    }

    console.log(
      `[consensus] Issue #${issue.number} has been debating for ${ageHours.toFixed(1)}h — calling consensus`,
    );

    const comments = await getIssueComments(issue.number);
    await handleConsensus(issue, comments);
    processed++;
  }

  console.log(`[consensus] Done. Called consensus on ${processed} issue(s).`);
}

main().catch(err => {
  console.error('[consensus] Fatal error:', err);
  process.exit(1);
});
