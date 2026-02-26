/**
 * implement.ts
 *
 * Called by the GitHub Actions implement workflow when a `consensus-reached`
 * label is added to an issue.
 *
 * Steps:
 *   1. Load the issue + full debate thread from GitHub API.
 *   2. Read the relevant game source files from disk (the workflow checks out
 *      the repo, so all files are available locally).
 *   3. Ask Claude to generate the implementation as structured file patches.
 *   4. Write each patched file to disk.
 *   5. Write a PR body to implement-pr-body.md (the workflow reads this to
 *      create the PR via `gh pr create --body-file`).
 *
 * Environment variables required:
 *   ISSUE_NUMBER       - GitHub issue number (set by the workflow)
 *   GITHUB_TOKEN       - PAT with issues read + contents write access
 *   GITHUB_REPO        - owner/repo  (e.g. "skemmis/crucible")
 *   ANTHROPIC_API_KEY  - Anthropic API key
 *
 * The workflow is responsible for:
 *   - Checking out the repo on a new branch
 *   - Running: npx tsx orchestrator/scripts/implement.ts
 *   - Committing any changed files
 *   - Creating the PR via gh
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { getIssue, getIssueComments } from '../src/github';

// ── Config ─────────────────────────────────────────────────────────────────

const ISSUE_NUMBER = parseInt(process.env.ISSUE_NUMBER ?? '', 10);
if (isNaN(ISSUE_NUMBER)) throw new Error('ISSUE_NUMBER env var is not set or not a number');

// When run by GitHub Actions the cwd is the repo root, so source files are
// at ./src/  relative to where we're running. When running locally from
// orchestrator/ the repo root is one level up.
const REPO_ROOT = fs.existsSync(path.join(process.cwd(), 'src'))
  ? process.cwd()
  : path.join(process.cwd(), '..');

const SOURCE_DIRS = ['src'];
const OUTPUT_PR_BODY = path.join(process.cwd(), 'implement-pr-body.md');

// ── Read source tree ───────────────────────────────────────────────────────

function readSourceFiles(): Map<string, string> {
  const files = new Map<string, string>();

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules and hidden dirs
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile() && /\.(ts|js|json|md)$/.test(entry.name)) {
        const rel = path.relative(REPO_ROOT, full);
        files.set(rel, fs.readFileSync(full, 'utf-8'));
      }
    }
  }

  for (const dir of SOURCE_DIRS) {
    const abs = path.join(REPO_ROOT, dir);
    if (fs.existsSync(abs)) walk(abs);
  }

  return files;
}

// ── Prompt ────────────────────────────────────────────────────────────────

function buildImplementPrompt(
  issueTitle: string,
  issueBody: string,
  debateThread: string,
  sourceFiles: Map<string, string>,
): string {
  const filesSection = [...sourceFiles.entries()]
    .map(([relPath, content]) => `### ${relPath}\n\`\`\`typescript\n${content}\n\`\`\``)
    .join('\n\n');

  return `\
You are implementing a feature for Crucible, an open-source TypeScript evolution simulation.

A proposal was debated by a panel of AI agents and reached consensus. Your job is to implement \
exactly what was agreed — no more, no less.

## Proposal: #${ISSUE_NUMBER} — ${issueTitle}

${issueBody}

## Debate & Consensus

${debateThread}

## Current source files

${filesSection}

---

## Instructions

Implement the consensus decision. Be surgical — touch only what's necessary. \
Keep changes consistent with the existing code style and architecture.

Output your response in EXACTLY this format:

IMPLEMENTATION_START
---FILE: <relative/path/from/repo/root.ts>
<full new content of the file>
---FILE: <another/file.ts>
<full new content>
IMPLEMENTATION_END

PR_BODY_START
## Summary
<2–4 bullet points describing what was changed and why>

## Changes
<brief description of each file touched>

## Test plan
- [ ] Run \`npm run dev\` and verify the simulation starts without errors
- [ ] Observe the specific emergent behavior described in the consensus
- [ ] Check browser console for runtime errors

Closes #${ISSUE_NUMBER}
PR_BODY_END

Rules:
- Only output files you actually modified. Don't output files that are unchanged.
- Output the FULL new content of each modified file (not a diff).
- If no code changes are needed (e.g. the consensus was "needs rework"), output IMPLEMENTATION_START\\nIMPLEMENTATION_END with nothing between them, and explain in the PR body.
`;
}

// ── Parse Claude's structured output ──────────────────────────────────────

interface ParsedImplementation {
  files: Map<string, string>; // relPath → newContent
  prBody: string;
}

function parseImplementation(response: string): ParsedImplementation {
  const files = new Map<string, string>();

  // Extract file blocks
  const implMatch = response.match(/IMPLEMENTATION_START\n([\s\S]*?)\nIMPLEMENTATION_END/);
  if (implMatch) {
    const implBlock = implMatch[1];
    // Split on ---FILE: markers
    const fileChunks = implBlock.split(/^---FILE: /m).filter(Boolean);
    for (const chunk of fileChunks) {
      const newline = chunk.indexOf('\n');
      if (newline === -1) continue;
      const filePath = chunk.slice(0, newline).trim();
      const fileContent = chunk.slice(newline + 1);
      if (filePath) files.set(filePath, fileContent);
    }
  }

  // Extract PR body
  const prMatch = response.match(/PR_BODY_START\n([\s\S]*?)\nPR_BODY_END/);
  const prBody = prMatch ? prMatch[1].trim() : '(implementation complete — see commit for details)';

  return { files, prBody };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[implement] Starting implementation for issue #${ISSUE_NUMBER}`);

  // 1. Load issue + debate
  const issue = await getIssue(ISSUE_NUMBER);
  const comments = await getIssueComments(ISSUE_NUMBER);
  console.log(`[implement] Loaded issue "${issue.title}" with ${comments.length} comments`);

  const debateThread = comments
    .map(c => `**${c.user.login}**:\n${c.body}`)
    .join('\n\n---\n\n');

  // 2. Read source files
  const sourceFiles = readSourceFiles();
  console.log(`[implement] Read ${sourceFiles.size} source file(s) from ${REPO_ROOT}`);

  // 3. Call Claude
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const client = new Anthropic({ apiKey });

  const prompt = buildImplementPrompt(
    issue.title,
    issue.body ?? '(no description)',
    debateThread,
    sourceFiles,
  );

  console.log(`[implement] Calling Claude to generate implementation…`);
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 24000,
    thinking: { type: 'enabled', budget_tokens: 8000 } as any,
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = message.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text block in Claude response');
  }
  const responseText = textBlock.text;

  // 4. Parse
  const { files, prBody } = parseImplementation(responseText);
  console.log(`[implement] Claude generated ${files.size} file change(s)`);

  // 5. Write files to disk
  for (const [relPath, content] of files) {
    const absPath = path.join(REPO_ROOT, relPath);
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
    console.log(`[implement] Wrote ${relPath}`);
  }

  // 6. Write PR body
  fs.writeFileSync(OUTPUT_PR_BODY, prBody, 'utf-8');
  console.log(`[implement] PR body written to ${OUTPUT_PR_BODY}`);

  if (files.size === 0) {
    console.warn('[implement] WARNING: No files were changed. Check the PR body for details.');
  }

  console.log(`[implement] Done.`);
}

main().catch(err => {
  console.error('[implement] Fatal error:', err);
  process.exit(1);
});
