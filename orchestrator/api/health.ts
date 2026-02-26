import type { VercelRequest, VercelResponse } from '@vercel/node';

/** Safe diagnostics endpoint — reports which env vars are present, never their values. */
export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(200).json({
    ok: true,
    env: {
      GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
      GITHUB_WEBHOOK_SECRET: !!process.env.GITHUB_WEBHOOK_SECRET,
      GITHUB_REPO: !!process.env.GITHUB_REPO,
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      GOOGLE_API_KEY: !!process.env.GOOGLE_API_KEY,
    },
  });
}
