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

Fluxo completo funcionando:

```
__start__ → saudacao → lgpd [INTERRUPT]
  → lgpd_processar → lgpd_recusado → encerramento
                   → primeira_mensagem [INTERRUPT]
                       → triagem (Bedrock RAG classifica)
                           → informativo (Bedrock RAG responde acolhendo)
                               → [subgrafo do serviço] → dados_pessoais [INTERRUPT]
                                   → dados_residenciais [INTERRUPT]
                                       → dados_contato [INTERRUPT]
                                           → encerramento → __end__
```

**Nodes com IA real:** `triagem.ts` e `informativo.ts` usam `AmazonKnowledgeBaseRetriever` + `ChatBedrockConverse`.

**Serviços:** `familia_pensao` | `trabalhista` | `inss_federal` | `penal` → `outros`

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
  state.ts            ← GraphAnnotation: messages, lgpdAceito, categoria, dadosColetados
  server.ts           ← Express POST /api/chat (lógica de resume)
  nodes/
    onboarding/       saudacao.ts | lgpd.ts | primeira-mensagem.ts
    atendimento/      triagem.ts (RAG) | informativo.ts (RAG) | encerramento.ts
    coleta/           dados-pessoais.ts | dados-residenciais.ts | dados-contato.ts
  services/
    familia-pensao/   graph.ts (subgrafo — shell)
    trabalhista/      graph.ts (subgrafo — shell)
    inss/             graph.ts (subgrafo — shell)
    outros/           graph.ts (subgrafo — shell)
docs/
  plano-implementacao.md  ← blueprint completo das próximas fases
  servicos.md             ← conteúdo do KB (S3)
  guia-linguagem.md       ← guia de tom/linguagem (a preencher pela DPERJ)
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
# Próximas fases:
DPERJ_API_URL=
DPERJ_API_KEY=
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

### Imediato (Fase 2)
- [ ] `src/nodes/atendimento/extrator.ts` — agente que extrai campos do contexto da conversa para `dadosColetados` (evita repetir perguntas)
- [ ] Perguntas reais nos subgrafos `services/familia-pensao`, `trabalhista`, `inss`, `outros`
- [ ] Perguntas reais nos nodes `coleta/dados-pessoais`, `dados-residenciais`, `dados-contato`
- [ ] Preencher `docs/guia-linguagem.md` com diretrizes reais da DPERJ

### Próximo (Fase 3)
- [ ] `src/nodes/atendimento/enviar-dados.ts` — POST para API da DPERJ no encerramento
- [ ] `encerramento.ts` mostrar número de protocolo retornado pela API

### Posterior (Fases 4–6)
- [ ] WhatsApp Business API (webhook + sender) em `src/channels/whatsapp.ts`
- [ ] Migrar Express → Fastify + SQLite → PostgreSQL
- [ ] Painel admin SaaS: Vite + React + React Flow (builder visual)
- [ ] Multi-tenant + billing

> Ver `docs/plano-implementacao.md` para o blueprint técnico detalhado de cada fase.

---

## Como Adicionar Novo Tipo de Serviço

1. Criar `src/services/<nome>/graph.ts` (copiar de `outros/graph.ts`)
2. Importar e registrar em `graph.ts` (`.addNode` + `.addEdge` a partir de `outros`)
3. Adicionar categoria em `triagemRoute` em `nodes/atendimento/triagem.ts`
4. Adicionar edge em `informativo` conditional em `graph.ts`
5. Atualizar `docs/servicos.md` e re-sincronizar KB
