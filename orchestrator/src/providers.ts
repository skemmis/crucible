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

async function callClaude(agent: AgentConfig, userPrompt: string): Promise<string> {
  const client = anthropicClient();
  const message = await client.messages.create({
    model: agent.model,
    max_tokens: 1024,
    system: agent.systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const block = message.content[0];
  if (block.type !== 'text') throw new Error('Unexpected response type from Claude');
  return block.text;
}

async function callGemini(agent: AgentConfig, userPrompt: string): Promise<string> {
  const client = googleClient();
  const model = client.getGenerativeModel({
    model: agent.model,
    systemInstruction: agent.systemPrompt,
  });

  const result = await model.generateContent(userPrompt);
  const text = result.response.text();
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}
