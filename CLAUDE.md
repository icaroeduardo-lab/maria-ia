# Maria Chat — CLAUDE.md

> Este arquivo é o contexto principal para a IA continuar o desenvolvimento.
> Leia também `docs/plano-implementacao.md` para o plano detalhado de cada fase.

---

## O Produto

**Maria Chat** — plataforma de atendimento jurídico conversacional com IA para a **Defensoria Pública do Estado do Rio de Janeiro (DPERJ)**.

Substitui o chatbot atual da Defensoria por uma IA conversacional que:
- Atende via **WhatsApp Business** (canal principal) e web
- Identifica o serviço jurídico pelo que o assistido descreve em linguagem natural
- Faz as perguntas necessárias sem repetir o que já foi respondido (extração de contexto)
- Envia os dados coletados para o sistema interno da DPERJ ao final
- É administrável por gestores sem conhecimento técnico via painel visual

**Usuários finais:** cidadãos do RJ que não podem pagar advogado.
**Usuários admin:** gestores da DPERJ que configuram fluxos e perguntas via painel.

---

## Estado Atual — O Que Está Construído (MVP)

### Engine LangGraph (`src/`)

Fluxo completo funcionando (Fases 2 e 3 concluídas):

```
__start__ → saudacao → lgpd [INTERRUPT]
  → lgpd_processar → lgpd_recusado → encerramento
                   → primeira_mensagem [INTERRUPT]
                       → triagem (Bedrock RAG classifica)
                           → extrator_inicial (extrai campos da descrição)
                               → informativo (Bedrock RAG acolhe)
                                   → roteador ─┐
                                               ▼
            ┌─────────── LOOP DE PERGUNTAS ───────────────┐
            │ [node de pergunta] faz 1 pergunta [INTERRUPT]│
            │   → extrator (LLM extrai resposta+contexto)  │
            │   → roteador: próxima pergunta pendente ou ↓ │
            └──────────────────────────────────────────────┘
                                               ▼
                          enviar_dados (POST DPERJ → protocolo)
                                               ▼
                                          encerramento → __end__
```

**Nodes de pergunta no loop:** subgrafos de serviço (`familia_pensao`, `trabalhista`, `inss`, `outros`) e coleta (`dados_pessoais`, `dados_residenciais`, `dados_contato`). Cada um pergunta o próximo item pendente do seu grupo. O `roteador` (em `registro-perguntas.ts`) decide: perguntas do serviço → pessoais → residenciais → contato → encerramento.

**Nodes com IA real:** `triagem.ts` e `informativo.ts` (RAG) e `extrator.ts` (structured output Zod).

**Envio à DPERJ (`src/dperj.ts` + `nodes/atendimento/enviar-dados.ts`):**
- `DPERJ_API_URL` vazia → modo mock: gera protocolo local `MARIA-<ano>-<seq>` e loga o payload
- POST com `Authorization: Bearer DPERJ_API_KEY`, timeout 10s; resposta esperada `{ protocolo }`
- Falha → payload entra na fila SQLite `data/fila-envios.db`; `processarFila()` roda a cada 5min no server; encerramento degrada para mensagem sem protocolo

**Serviços:** `familia_pensao` | `trabalhista` | `inss_federal` | `penal` → `outros`

**Extrator (`nodes/atendimento/extrator.ts`) — anti-alucinação (Haiku chuta muito):**
- Processa SÓ a última mensagem do usuário (histórico já foi extraído nos turnos anteriores)
- Schema dinâmico: só campos ainda não coletados; campos de identidade/endereço/contato só entram quando a última pergunta é do mesmo grupo
- Campos sim/não de serviço só valem como resposta direta à pergunta (senão Haiku inventa "não")
- Blacklist de placeholders (`<UNKNOWN>`, `N/A`...), validação de opções contra a lista oficial
- `Pergunta.validar` rejeita valor inferido inválido (ex: "meu marido" como nome) → pergunta é feita
- Fallback anti-loop: pergunta respondida sem extração → guarda resposta bruta

### Stack Atual

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20 + TypeScript ESM/NodeNext |
| Orquestração IA | LangGraph JS `^1.3.7` |
| LLM | AWS Bedrock — Claude 3 Haiku (`ChatBedrockConverse`) |
| RAG | Bedrock Knowledge Base — `AmazonKnowledgeBaseRetriever` |
| Embeddings | Amazon Titan Embed v2 (1024 dims, cosine, S3 Vectors) |
| Persistência | SQLite — `SqliteSaver` → `data/checkpoints.db` |
| Servidor | Express v5 — `src/server.ts` |
| Package manager | pnpm |

### Estrutura de Pastas

```
src/
  graph.ts            ← grafo principal compilado + SqliteSaver
  state.ts            ← GraphAnnotation: messages, lgpdAceito, categoria, dadosColetados,
                        perguntasFeitas, ultimaPergunta, servicoConcluido, canal,
                        iniciadoEm, protocolo
  perguntas.ts        ← interface Pergunta + helpers (proxima, mensagemPergunta, nodePergunta)
  registro-perguntas.ts ← registro de todos os grupos de perguntas + roteador
  dperj.ts            ← cliente API DPERJ + fila de retry (data/fila-envios.db)
  server.ts           ← Express POST /api/chat (lógica de resume) + retry da fila a cada 5min
  nodes/
    onboarding/       saudacao.ts | lgpd.ts | primeira-mensagem.ts
    atendimento/      triagem.ts (RAG) | informativo.ts (RAG) | extrator.ts |
                      enviar-dados.ts | encerramento.ts
    coleta/           dados-pessoais.ts | dados-residenciais.ts | dados-contato.ts
  services/
    familia-pensao/   graph.ts (subgrafo + PERGUNTAS_FAMILIA)
    trabalhista/      graph.ts (subgrafo + PERGUNTAS_TRABALHISTA)
    inss/             graph.ts (subgrafo + PERGUNTAS_INSS)
    outros/           graph.ts (subgrafo + PERGUNTAS_OUTROS)
docs/
  plano-implementacao.md  ← blueprint completo das próximas fases
  servicos.md             ← conteúdo do KB (S3)
  guia-linguagem.md       ← guia de tom/linguagem (rascunho — validar com DPERJ)
data/
  checkpoints.db          ← SQLite, gitignored
public/
  index.html              ← frontend web (estilo WhatsApp)
docker-compose.yml        ← postgres + redis + backend + frontend + nginx
Dockerfile.backend        ← build multi-stage Node.js 22 Alpine
nginx/nginx.conf          ← reverse proxy
```

### Variáveis de Ambiente (`.env` — nunca commitar)

```
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=anthropic.claude-3-haiku-20240307-v1:0
BEDROCK_KB_ID=LF04FDVIYP
BEDROCK_KB_DS_ID=V6AOSMT9CQ
LANGSMITH_API_KEY=
# Fase 3 — vazio = modo mock (protocolo local):
DPERJ_API_URL=
DPERJ_API_KEY=
# Próximas fases:
WA_PHONE_NUMBER_ID=
WA_ACCESS_TOKEN=
WA_WEBHOOK_VERIFY_TOKEN=
POSTGRES_URL=
REDIS_URL=
```

### Recursos AWS Criados

| Recurso | ID / Nome |
|---|---|
| Bedrock KB | `LF04FDVIYP` |
| KB Data Source | `V6AOSMT9CQ` |
| S3 docs bucket | `maria-ia-kb-docs` |
| S3 Vectors bucket | `maria-ia-kb-vectors` |
| S3 Vectors index | `maria-ia-index` |
| IAM Role | `maria-ia-kb-role` |
| Imagem Maria | `https://maria-ia.s3.us-east-1.amazonaws.com/maria-ia.webp` |

---

## Comandos

```bash
pnpm server        # inicia servidor em http://localhost:3000
pnpm studio        # LangGraph Studio (visualização do grafo)
pnpm build         # compila TypeScript

docker compose up postgres redis   # sobe só o banco para dev
docker compose up                  # sobe tudo
docker compose --profile prod up   # sobe com nginx (produção)
```

---

## Padrão Crítico de Multi-turn — NUNCA MUDAR

O grafo usa `interruptAfter` + `SqliteSaver`. O servidor **não pode** passar input não-nulo em thread existente — isso reinicia o grafo do zero.

```typescript
// ✅ 1ª chamada (thread novo — sem histórico):
await graph.invoke({}, config);

// ✅ Chamadas seguintes (resume após interrupt):
await graph.updateState(config, { messages: [new HumanMessage(message)] });
await graph.invoke(null, config);

// ❌ ERRADO — reinicia do __start__ ignorando o checkpoint:
await graph.invoke({ messages: [new HumanMessage(message)] }, config);
```

Lógica em `server.ts`: `prevLen > 0` → updateState + invoke(null). Caso contrário → invoke({}).

---

## Tipos de Mensagem Customizados (frontend + WhatsApp)

Content blocks suportados além de `text`:

```typescript
{ type: "boolean", trueLabel: true, falseLabel: false }    // botão Sim/Não
{ type: "image_url", image_url: { url: "..." } }           // imagem
{ type: "options", options: ["opção 1", "opção 2", ...] }  // lista de opções
{ type: "text", text: "..." }                               // texto simples
```

No WhatsApp: `boolean` → `interactive/button`, `image_url` → `image`, `options` → `interactive/list`.

---

## RAG — Atualizar Knowledge Base

Após editar `docs/servicos.md` ou `docs/guia-linguagem.md`:

```bash
aws s3 cp docs/servicos.md s3://maria-ia-kb-docs/
aws s3 cp docs/guia-linguagem.md s3://maria-ia-kb-docs/
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id LF04FDVIYP \
  --data-source-id V6AOSMT9CQ \
  --region us-east-1
```

---

## O Que Falta Construir (TODO)

### ✅ Fase 2 — concluída (jun/2026)
- [x] `src/nodes/atendimento/extrator.ts` — extrai campos do contexto (evita repetir perguntas)
- [x] Perguntas reais nos subgrafos `services/familia-pensao`, `trabalhista`, `inss`, `outros`
- [x] Perguntas reais nos nodes `coleta/dados-pessoais`, `dados-residenciais`, `dados-contato`
- [x] `docs/guia-linguagem.md` preenchido (rascunho — falta validação final da DPERJ)

### ✅ Fase 3 — concluída (jun/2026)
- [x] `src/nodes/atendimento/enviar-dados.ts` — POST para API da DPERJ no encerramento
- [x] `encerramento.ts` mostrar número de protocolo retornado pela API
- [ ] Trocar mock pela URL/contrato reais quando a DPERJ liberar a API (`.env`: `DPERJ_API_URL`, `DPERJ_API_KEY`)

### Posterior (Fases 4–6)
- [ ] WhatsApp Business API (webhook + sender) em `src/channels/whatsapp.ts`
- [ ] Migrar Express → Fastify + SQLite → PostgreSQL
- [ ] Painel admin SaaS: Vite + React + React Flow (builder visual)
- [ ] Multi-tenant + billing

> Ver `docs/plano-implementacao.md` para o blueprint técnico detalhado de cada fase.

---

## Como Adicionar Novo Tipo de Serviço

1. Criar `src/services/<nome>/graph.ts` (copiar de `outros/graph.ts`): definir `PERGUNTAS_<NOME>` e exportar o subgrafo com `nodePergunta(PERGUNTAS_<NOME>)`
2. Adicionar a categoria em `CATEGORIAS` em `nodes/atendimento/triagem.ts`
3. Registrar em `SERVICOS` em `src/registro-perguntas.ts` (categoria → node + perguntas)
4. Em `graph.ts`: `.addNode`, edge do node → `"extrator"`, e entrada em `DESTINOS_ROTEADOR` + `interruptAfter`
5. Atualizar `docs/servicos.md` e re-sincronizar KB
