# Spec: Handoff de sessão Mac ↔ Telegram/VM

**Data:** 2026-06-13
**Projeto:** claudegram
**Status:** design aprovado, pendente plano de implementação

## Problema

Cadu usa o Claude Code de dois jeitos: localmente no Mac e via Telegram (bot `@olitermbot`)
contra o agente que roda na VM Contabo. Hoje as duas sessões são mundos separados — não há
como começar uma conversa num ambiente e continuar no outro com o contexto preservado.

## Objetivo

Permitir **handoff explícito, sob demanda, da mesma conversa** entre o Mac e o Telegram/VM,
nas duas direções, preservando o contexto. Escopo deliberadamente enxuto: **só a conversa**
(o transcript), não o estado de arquivos (os repos já existem nos dois lados via git).

## Decisões de design (do brainstorming)

- **Caso de uso:** handoff da mesma conversa viva (não "listar/resumir", não "estado de arquivos").
- **Gatilho:** comando explícito sob demanda. Sem sync contínuo, sem daemon.
- **Escopo do payload:** só conversa/contexto. Arquivos via git como já é feito.
- **Mapa de paths:** `/workspace` (VM/container) ↔ `/Users/caduolivera/Documents/projects/maxpan` (Mac).
- **Unificação de repos:** renomear na VM os repos que divergem, pra casar com os nomes do Mac
  (Mac é a fonte da verdade — o tooling de dev-loop/release/worktrees aponta pra `maxpan/`).
  Mantém `cwd=/workspace` (sessões atuais intactas).
- **Telegram → Mac:** já coberto pelo `pull` (Mac-iniciado). Sem flag/watcher extra.

## Princípio central

Uma conversa = **um `session-id` estável**. O transcript (`<id>.jsonl`) faz ping-pong entre
Mac e VM; cada lado dá `claude --resume <id>` e **anexa** ao mesmo arquivo. Como o handoff é
explícito (um lado ativo por vez), não há escrita concorrente — quem tem o arquivo mais novo é
a fonte da verdade. O `session-id` nunca muda, então o histórico é contínuo de verdade.

## Arquitetura

### Localização dos artefatos (acessíveis via `ssh contabo`)

- **Transcripts (VM):** `/root/.claude/projects/-workspace/<id>.jsonl` — bind-mount do host,
  `scp` direto. (O dir de projeto = `cwd` com `/`→`-`.)
- **Registro de sessões do bot (VM):** `docker exec claudegram cat /root/.claudegram/sessions.json`
  — mapeia `sessionKey` (tópico) → `claudeSessionId` + `lastMessagePreview` + `projectPath`.
  Mora num volume Docker; ler/escrever sempre **de dentro do processo do bot** (a cópia em
  memória do bot sobrescreveria edições externas — não editar por fora).
- **Transcripts (Mac):** `~/.claude/projects/-Users-caduolivera-Documents-projects-maxpan/<id>.jsonl`.

### Componentes

1. **CLI `claudegram` (no Mac).** Único binário/script novo do lado do usuário. Subcomandos:
   - `claudegram pull [--pick]` — continuar no Mac uma conversa do Telegram.
   - `claudegram push [<session-id>]` — mandar uma conversa do Mac pro Telegram.
   - Config (env ou arquivo): `CLAUDEGRAM_SSH_HOST=contabo`, `CLAUDEGRAM_REMOTE_CWD=/workspace`,
     `CLAUDEGRAM_LOCAL_WORKSPACE=/Users/caduolivera/Documents/projects/maxpan`.

2. **Comando `/adopt` (no bot, ~15 linhas em `command.handler.ts`).** Necessário só pro `push`.
   Lista as sessões recém-`push`adas (ou aceita `<id>`) e fixa o `claudeSessionId` no tópico
   atual via `sessionManager.setClaudeSessionId()` + `sessionHistory`. Feito dentro do processo
   → sem corrida com `sessions.json`.

## Fluxos (data flow)

### `pull` — Telegram → Mac (zero código novo na VM)

1. CLI lê `sessions.json` da VM por SSH, lista tópicos (preview + `claudeSessionId`); usuário escolhe.
2. CLI `scp` do `<id>.jsonl` (VM `-workspace`) → dir de projeto local do Mac.
3. CLI roda/imprime `cd $CLAUDEGRAM_LOCAL_WORKSPACE && claude --resume <id>`.
4. Claude no Mac carrega o transcript (indexado pelo cwd local), resume com contexto completo.
   Paths `/workspace/...` internos viram histórico; ops novas rodam no cwd local — e com os
   nomes de repo unificados, resolvem por caminho relativo.

### `push` — Mac → Telegram

1. CLI pega a sessão local (mais recente do workspace, ou `<id>` passado).
2. CLI `scp` do jsonl local → VM `/root/.claude/projects/-workspace/<id>.jsonl`.
3. CLI imprime o `<id>` e a instrução.
4. No tópico desejado do Telegram, usuário manda `/adopt <id>` → bot fixa a sessão no tópico.
5. Próxima mensagem no tópico dá `resume` com o contexto do Mac.

## Pré-requisito: unificar nomes de repo (VM → Mac)

Renomear na VM (`/opt/claudegram/workspace/`) os repos que divergem, pra casar com `maxpan/`.
Mantém `cwd=/workspace`, então a estrutura *relativa* fica idêntica e o modelo acha tudo por
caminho relativo após o handoff. Renomeações claras:

| VM `/workspace` | Mac `maxpan/` |
|---|---|
| `backend` | `back` |
| `ms-ai` | `ai-ms` |
| `ms-operation` | `operation-ms` |
| `ms-routines` | `routines-ms` |
| `ms-ping` | `ping-ms` |
| `university` | `university-ms` |

Já casam (sem ação): `automation-ms`, `boilerplate-ms`, `deploy-console`, `front-backoffice`,
`kiosk-boilerplate`, `linvo-fin`, `linvo-flow`, `linvo-id`, `service-status`, `utils`.

A confirmar (só relevante se um handoff tocar neles): `ms-mobile`, `app-pos-laundry`,
`app-pos-locker`, `wallet`, `evolution-api`. Atualizar refs em `claudegram/CLAUDE.md` se houver.

## Tratamento de erros

- **Anti-clobber:** antes de sobrescrever um jsonl no destino, comparar `mtime`/nº de linhas;
  se o destino for mais novo, abortar e exigir `--force` (evita matar contexto por handoff invertido).
- **Repo ausente:** se o transcript citar um repo que não existe no destino, avisar (sugerir
  `git clone`/`git pull`); não bloquear o resume.
- **`pull` é read-only** na VM; `push` só escreve arquivo de sessão. `/adopt` valida que o
  `<id>.jsonl` existe antes de fixar.

## Testes / validação

- **Spike (PRIMEIRO PASSO, antes de construir o CLI):** copiar uma sessão real da VM pro Mac e
  rodar `claude --resume <id>` pra validar que (1) o contexto volta e (2) com os nomes já
  unificados o modelo opera limpo no `maxpan/`. Se travar, ajustar o design antes de codar o resto.
- Teste manual ida-e-volta: começar conversa no Telegram → `pull` no Mac → continuar →
  `push` de volta → `/adopt` → confirmar contexto contínuo nos dois lados.

## Fora de escopo (YAGNI)

- Sync contínuo / mirroring automático.
- Watcher no Mac / handoff auto-entregue ("mágico").
- Arquivos não-commitados no payload.
- Tradução de paths absolutos dentro do transcript.
- Multi-máquina além do Mac do Cadu.

## Riscos conhecidos

- Divergência de **prefixo absoluto** (`/workspace` vs `…/maxpan`) permanece nos paths
  históricos do transcript — cosmético, o modelo opera pelo cwd. O spike confirma o impacto real.
- Renomear repos na VM afeta o workspace do bot; fazer com cuidado na fase de implementação
  (env secundário, mas há sessões vivas referenciando paths).
