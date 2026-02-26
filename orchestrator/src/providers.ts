import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AgentConfig } from './agents';

// ── Client singletons ──────────────────────────────────────────────────────

let _anthropic: Anthropic | null = null;
let _google: GoogleGenerativeAI | null = null;

function anthropicClient(): Anthropic {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    _anthropic = new Anthropic({ apiKey });
  }
  return _anthropic;
}

function googleClient(): GoogleGenerativeAI {
  if (!_google) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_API_KEY is not set');
    _google = new GoogleGenerativeAI(apiKey);
  }
  return _google;
}

// ── Core call ──────────────────────────────────────────────────────────────

export async function callAgent(agent: AgentConfig, userPrompt: string): Promise<string> {
  if (agent.provider === 'anthropic') {
    return callClaude(agent, userPrompt);
  } else {
    return callGemini(agent, userPrompt);
  }
}

// ── Claude (extended thinking via standard API) ───────────────────────────
// claude-sonnet-4-6 supports extended thinking natively through the standard
// messages API. The response contains thinking blocks (internal reasoning) and
// text blocks — we discard the thinking blocks and return only the text.

async function callClaude(agent: AgentConfig, userPrompt: string): Promise<string> {
  const client = anthropicClient();

  const message = await client.messages.create({
    model: agent.model,
    max_tokens: 16000,        // must be ≥ budget_tokens + expected output
    thinking: {
      type: 'enabled',
      budget_tokens: 8000,    // up to 8k tokens of internal reasoning
    } as any,                 // thinking is natively supported; cast for SDK compat
    system: agent.systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  // Extended thinking responses intermix thinking blocks and text blocks.
  // Extract only the visible text block(s).
  const textBlock = message.content.find(block => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error(`No text block in Claude response — got: ${message.content.map(b => b.type).join(', ')}`);
  }
  return textBlock.text;
}

// ── Gemini (reasoning via gemini-2.5-pro) ─────────────────────────────────
// gemini-2.5-pro has built-in thinking. thinkingBudget sets the token budget
// for internal reasoning; 5000 is a good balance of quality vs. latency.

async function callGemini(agent: AgentConfig, userPrompt: string): Promise<string> {
  const client = googleClient();
  const model = client.getGenerativeModel({
    model: agent.model,
    systemInstruction: agent.systemPrompt,
  });

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    // thinkingConfig supported in @google/generative-ai ≥0.24.0
    generationConfig: {
      thinkingConfig: { thinkingBudget: 5000 },
    } as any,
  });

  const text = result.response.text();
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}
