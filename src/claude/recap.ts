import * as fs from 'fs';
import { config } from '../config.js';

// Recap is generated here on the bot (Linux, no macOS TCC popups) rather than on
// the Mac via `claude -p` — so both manual AND scheduled (launchd) syncs get a
// recap, and the Mac never spawns recap sessions that pollute ~/.claude/projects.
// Uses Groq (key already in the container) via its OpenAI-compatible endpoint.
const GROQ_CHAT_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const RECAP_MODEL = process.env.CLAUDEGRAM_RECAP_GROQ_MODEL || 'llama-3.3-70b-versatile';

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

/**
 * Generate a short PT recap of a session's transcript to post as the opening
 * message of its Telegram topic. Best-effort: returns null (and the caller falls
 * back to just the ready line) if Groq isn't configured, the transcript is
 * unreadable/empty, or the call fails.
 */
export async function generateRecap(transcriptPath: string): Promise<string | null> {
  if (!config.GROQ_API_KEY) return null;
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch { return null; }
  const condensed = condenseTranscript(raw);
  if (!condensed) return null;

  const prompt = [
    'Você recebe a transcrição condensada de uma sessão de trabalho com o Claude Code',
    '(linhas [U]=usuário, [A]=assistente). Escreva um recap em português de 2 a 4 linhas',
    'curtas para servir de contexto no topo de um tópico do Telegram: do que se trata,',
    'o que foi feito/decidido, e o estado atual. Sem saudação, sem markdown, sem listas,',
    'apenas o texto do recap.',
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
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      console.error('[recap] groq error', res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const recap = (data.choices?.[0]?.message?.content || '').trim();
    return recap ? recap.slice(0, 600) : null;
  } catch (err) {
    console.error('[recap] failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
