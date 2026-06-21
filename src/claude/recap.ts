import * as fs from 'fs';
import { config } from '../config.js';

// Recap is generated here on the bot (Linux, no macOS TCC popups) rather than on
// the Mac via `claude -p` — so both manual AND scheduled (launchd) syncs get a
// recap, and the Mac never spawns recap sessions that pollute ~/.claude/projects.
// Uses Groq (key already in the container) via its OpenAI-compatible endpoint.
const GROQ_CHAT_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
// 8b-instant has a much larger free-tier daily token budget than 70b-versatile
// (which caps at 100k tokens/day and gets exhausted by a bulk re-sync), so it's
// the reliable default for per-topic generation. Override via env if desired.
const RECAP_MODEL = process.env.CLAUDEGRAM_RECAP_GROQ_MODEL || 'llama-3.1-8b-instant';

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
 * In one Groq call, derive a content emoji + a short descriptive title + a recap
 * from a session's transcript. Used to name the Telegram topic and post its
 * opening context. Best-effort: returns null (caller falls back to the aiTitle +
 * status emoji and no recap) if Groq isn't configured, the transcript is
 * unreadable/empty, the call fails, or the JSON can't be parsed.
 */
export async function generateTopicMeta(transcriptPath: string): Promise<TopicMeta | null> {
  if (!config.GROQ_API_KEY) return null;
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return null; }
  const condensed = condenseTranscript(raw);
  if (!condensed) return null;

  const prompt = [
    'Você recebe a transcrição condensada de uma sessão de trabalho com o Claude Code',
    '(linhas [U]=usuário, [A]=assistente). Responda APENAS com um objeto JSON com as chaves:',
    '- "emoji": UM único caractere emoji REAL (ex: 🐛 🚀 📊 🔧 🗄️ 🔐 📱), nunca um código tipo ":bug:". Escolha um que represente o tema, pra identificar o tópico de relance.',
    '- "title": um título curto e específico (no máximo ~6 palavras), no idioma predominante da conversa, fácil de reconhecer. Sem emoji no título.',
    '- "recap": 2 a 4 linhas curtas de contexto — do que se trata, o que foi feito/decidido, e o estado atual. Sem markdown, sem listas.',
    '',
    '--- TRANSCRIÇÃO ---',
    condensed,
  ].join('\n');

  try {
    const res = await fetch(GROQ_CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: RECAP_MODEL,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 400,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      console.error('[recap] groq error', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content || '';
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
  } catch (err) {
    console.error('[recap] failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
