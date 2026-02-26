import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import type { AgentConfig } from './agents';

// ── Client singletons ──────────────────────────────────────────────────────

let _anthropic: Anthropic | null = null;
let _google: GoogleGenAI | null = null;

function anthropicClient(): Anthropic {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    _anthropic = new Anthropic({ apiKey });
  }
  return _anthropic;
}

function googleClient(): GoogleGenAI {
  if (!_google) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_API_KEY is not set');
    _google = new GoogleGenAI({ apiKey });
  }
  return _google;
}

// ── Core call ──────────────────────────────────────────────────────────────

/**
 * Call an agent's underlying LLM with a user prompt.
 * Returns the text response.
 */
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
  const response = await client.models.generateContent({
    model: agent.model,
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    config: { systemInstruction: agent.systemPrompt },
  });

  const text = response.text;
  if (!text) throw new Error('Empty response from Gemini');
  return text;
}
