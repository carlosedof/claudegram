import * as fs from 'fs';
import { config } from '../config.js';

// Recap is generated here on the bot (Linux, no macOS TCC popups) rather than on
// the Mac via `claude -p` — so both manual AND scheduled (launchd) syncs get a
// recap, and the Mac never spawns recap sessions that pollute ~/.claude/projects.
// LLM providers for topic meta, tried in order: Gemini 2.5-flash (smart, varied
// emojis, generous free tier) first, Groq (llama-3.1-8b) as fallback. Both via
// their OpenAI-compatible chat-completions endpoint + JSON mode. Models overridable
// via env. A 429/error on one provider falls through to the next.
interface LlmProvider { name: string; url: string; key: string; model: string; maxTokens: number; }
function llmProviders(): LlmProvider[] {
  const out: LlmProvider[] = [];
  if (config.GEMINI_API_KEY) {
    out.push({
      name: 'gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      key: config.GEMINI_API_KEY,
      model: process.env.CLAUDEGRAM_RECAP_GEMINI_MODEL || 'gemini-2.5-flash',
      maxTokens: 1200, // 2.5-flash spends tokens "thinking" before emitting the JSON
    });
  }
  if (config.GROQ_API_KEY) {
    out.push({
      name: 'groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: config.GROQ_API_KEY,
      model: process.env.CLAUDEGRAM_RECAP_GROQ_MODEL || 'llama-3.1-8b-instant',
      maxTokens: 500,
    });
  }
  return out;
}

// Try each provider in order; return the first non-empty JSON content, else null.
async function chatJSON(prompt: string): Promise<string | null> {
  for (const p of llmProviders()) {
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: p.model,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
          max_tokens: p.maxTokens,
          temperature: 0.3,
        }),
      });
      if (!res.ok) {
        console.error(`[recap] ${p.name} error`, res.status, (await res.text()).slice(0, 160));
        continue; // fall through to next provider
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = (data.choices?.[0]?.message?.content || '').trim();
      if (content) return content;
    } catch (err) {
      console.error(`[recap] ${p.name} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return null;
}

// Pull the first real emoji (incl. ZWJ sequences / variation selectors) out of a
// string. Weaker models sometimes return a shortcode like ":bug:" instead of 🐛,
// so we extract a genuine emoji char and fall back to 💬 when there isn't one.
function pickEmoji(s: string): string {
  const m = (s || '').match(/\p{Extended_Pictographic}(‍\p{Extended_Pictographic}|️)*/u);
  return m ? m[0] : '💬';
}

interface CondenseOpts {
  tailTurns?: number;
  perTurn?: number;
  maxChars?: number;
}

/**
 * Extract the readable conversation (user asks + assistant prose) from a
 * transcript, dropping tool calls / thinking / results, then keep the first turn
 * (the original ask = the topic) plus the last `tailTurns` turns (current state).
 * Bounded so it's cheap to summarize. Returns '' when nothing is readable.
 */
export function condenseTranscript(jsonlText: string, opts: CondenseOpts = {}): string {
  const { tailTurns = 16, perTurn = 500, maxChars = 9000 } = opts;
  const turns: string[] = [];
  for (const line of jsonlText.split('\n')) {
    if (!line.trim()) continue;
    let d: { type?: string; message?: { content?: unknown } };
    try { d = JSON.parse(line); } catch { continue; }
    const role = d.type === 'user' ? 'U' : d.type === 'assistant' ? 'A' : null;
    if (!role) continue;
    const content = d.message && d.message.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b): b is { type: string; text: string } =>
          !!b && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
        .map((b) => b.text)
        .join(' ');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text) turns.push(`[${role}] ${text.slice(0, perTurn)}`);
  }
  if (!turns.length) return '';
  const head = turns[0];
  const tail = turns.length > tailTurns ? turns.slice(-tailTurns) : turns.slice(1);
  const lines = [head];
  if (turns.length > tail.length + 1) lines.push('...');
  for (const t of tail) if (t !== head) lines.push(t);
  let out = lines.join('\n');
  if (out.length > maxChars) out = head + '\n...\n' + out.slice(-(maxChars - head.length - 5));
  return out;
}

export interface TopicMeta {
  emoji: string;       // one content emoji to make the topic identifiable at a glance
  title: string;       // short, specific title in the conversation's language
  recap: string | null; // 2–4 line context, posted as the opening message
}

/**
 * In one LLM call, derive a content emoji + a short descriptive title + a recap
 * from a session's transcript. Used to name the Telegram topic and post its
 * opening context. Best-effort: returns null (caller falls back to the aiTitle +
 * status emoji and no recap) if no provider is configured, the transcript is
 * unreadable/empty, every provider fails, or the JSON can't be parsed.
 */
export async function generateTopicMeta(transcriptPath: string): Promise<TopicMeta | null> {
  if (!config.GEMINI_API_KEY && !config.GROQ_API_KEY) return null;
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return null; }
  const condensed = condenseTranscript(raw);
  if (!condensed) return null;

  const prompt = [
    'Você recebe a transcrição condensada de uma sessão de trabalho com o Claude Code',
    '(linhas [U]=usuário, [A]=assistente). Responda APENAS com um objeto JSON com as chaves:',
    '- "emoji": UM único caractere emoji REAL (nunca um código tipo ":bug:"). Escolha um ESPECÍFICO para o tema da sessão (ex: 🐛 bug, 🚀 deploy, 🗄️ banco de dados, 🔐 auth, 📱 mobile, 💰 pagamento, 📧 email, 🔍 investigação). VARIE conforme o assunto — evite usar 📊 como padrão.',
    '- "title": um título curto e específico (no máximo ~6 palavras), no idioma predominante da conversa, fácil de reconhecer. Sem emoji no título.',
    '- "recap": 2 a 4 linhas curtas de contexto — do que se trata, o que foi feito/decidido, e o estado atual. Sem markdown, sem listas.',
    '',
    '--- TRANSCRIÇÃO ---',
    condensed,
  ].join('\n');

  const content = await chatJSON(prompt);
  if (!content) return null;

  let parsed: { emoji?: string; title?: string; recap?: string };
  try {
    parsed = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { parsed = JSON.parse(m[0]); } catch { return null; }
  }
  const title = (parsed.title || '').trim();
  if (!title) return null;
  const emoji = pickEmoji((parsed.emoji || '').trim());
  const recap = (parsed.recap || '').trim();
  return { emoji, title, recap: recap ? recap.slice(0, 600) : null };
}
