import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import {
  handleNewProposal,
  handleRound2,
  handleFollowUp,
  handleDiscussionRequest,
  handleConsensus,
  isHumanComment,
} from '../src/dispatch';
import { getIssue, getIssueComments } from '../src/github';

// ── Webhook signature verification ────────────────────────────────────────

type VerifyResult = 'ok' | 'missing-secret' | 'missing-signature' | 'invalid-signature';

function verifySignature(rawBody: string, signature: string | undefined): VerifyResult {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return 'missing-secret';
  if (!signature) return 'missing-signature';
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const valid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    return valid ? 'ok' : 'invalid-signature';
  } catch {
    return 'invalid-signature';
  }
}

// ── Raw body buffering ────────────────────────────────────────────────────
// Vercel's Node.js runtime does NOT pre-parse bodies for bare functions,
// so we read the stream directly. If the body was already consumed (edge case),
// fall back to re-serialising req.body.

function getRawBody(req: VercelRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    // If Vercel already parsed the body (shouldn't happen for bare functions,
    // but guard against it anyway)
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      resolve(JSON.stringify(req.body));
      return;
    }
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ── Main handler ──────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Only accept POSTs
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // Buffer raw body (needed for HMAC verification)
  const rawBody = await getRawBody(req);

  // Verify webhook signature
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const verifyResult = verifySignature(rawBody, signature);
  if (verifyResult !== 'ok') {
    console.warn(`[webhook] Auth failed: ${verifyResult} | body length: ${rawBody.length}`);
    res.status(401).send(verifyResult);
    return;
  }

  const eventType = req.headers['x-github-event'] as string;
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    res.status(400).send('Invalid JSON');
    return;
  }

  // ── Route events ──────────────────────────────────────────────────────
  // Process synchronously before responding — Vercel may freeze execution
  // after res.send(). With maxDuration:60 and parallel LLM calls (~10–15s)
  // we're well within limits.

  try {
    if (eventType === 'issues' && payload.action === 'opened') {
      const issue = payload.issue;
      const labels: string[] = issue.labels.map((l: any) => l.name);

      // Only trigger on issues labelled `proposed`
      if (labels.includes('proposed')) {
        await handleNewProposal(issue);
      }
    }

    else if (eventType === 'issues' && payload.action === 'labeled') {
      const issue = payload.issue;
      const addedLabel: string = payload.label.name;

      // Handle case where `proposed` label is added after issue creation
      if (addedLabel === 'proposed') {
        const currentLabels: string[] = issue.labels.map((l: any) => l.name);
        // Only fire if not already debating (idempotency guard)
        if (!currentLabels.includes('debating')) {
          await handleNewProposal(issue);
        }
      }

      // Round 1 complete → kick off Round 2
      if (addedLabel === 'round-1-done') {
        await handleRound2(issue);
      }
    }

    else if (eventType === 'issue_comment' && payload.action === 'created') {
      const issue = payload.issue;
      const comment = payload.comment;
      const labels: string[] = issue.labels.map((l: any) => l.name);

      // Don't respond to bot comments or agent comments (including our own)
      if (!isHumanComment(comment.user.login, comment.body)) {
        // fall through to res.status(200) at the bottom
      } else {
        const commentBody: string = comment.body ?? '';

        // ── /discuss command: re-opens debate on a completed issue ──────────
        // Fires when the issue has finished Round 2 but the user wants more.
        const isCompletedIssue =
          labels.includes('round-2-done') ||
          labels.includes('consensus-reached') ||
          labels.includes('needs-rework');

        if (isCompletedIssue && /\/discuss\b/i.test(commentBody)) {
          // Extract the concern: everything after `/discuss` on the same line
          // plus any subsequent lines.
          const discussMatch = commentBody.match(/\/discuss\b[^\S\r\n]*([\s\S]*)/i);
          const userConcern = discussMatch?.[1]?.trim() ?? '';

          if (userConcern) {
            const freshIssue = await getIssue(issue.number);
            await handleDiscussionRequest(freshIssue, userConcern);
          } else {
            console.log(`[webhook] Issue #${issue.number} — /discuss with no concern text, skipping`);
          }

        // ── Standard follow-up on an actively debating issue ────────────────
        } else if (labels.includes('debating')) {
          const [freshIssue, comments] = await Promise.all([
            getIssue(issue.number),
            getIssueComments(issue.number),
          ]);
          await handleFollowUp(freshIssue, comments);
        }
      }
    }
  } catch (err) {
    console.error('[webhook] Error handling event:', err);
    res.status(500).send('Internal Server Error');
    return;
  }

  // Respond after processing is complete
  res.status(200).send('OK');
}
