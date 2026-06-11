# Maria Chat — CLAUDE.md

---

## Produto

### O que é

**Maria Chat** é uma plataforma de atendimento jurídico conversacional com IA para a **Defensoria Pública do Estado do Rio de Janeiro (DPERJ)**. Substitui o chatbot atual da Defensoria por uma experiência guiada por inteligência artificial — natural, acolhedora e inteligente.

O canal principal é o **WhatsApp Business**. A Maria conduz a conversa, identifica o serviço necessário, faz as perguntas certas e ao final envia os dados coletados automaticamente para o sistema interno da Defensoria para abertura do atendimento.

### Problema que resolve

O chatbot atual da DPERJ é rígido, burocrático e com fluxo fixo de menus. Isso gera:
- Abandono de conversa por frustração com a UX
- Respostas fora do roteiro não reconhecidas
- Atendentes humanos sobrecarregados com dados incompletos ou mal coletados
- Impossibilidade de adaptar o fluxo sem desenvolvimento

### Solução

A Maria Chat resolve isso com uma conversa inteligente de ponta a ponta:

1. **Triagem por IA** — o assistido descreve o problema em linguagem natural; a IA identifica automaticamente qual serviço é adequado
2. **Extração de contexto** — se o assistido já mencionou alguma informação durante a conversa (ex: "tenho um filho menor"), a IA captura e não pergunta novamente
3. **Perguntas dinâmicas** — cada serviço tem seu próprio conjunto de perguntas obrigatórias; a IA só avança quando tiver todas
4. **Envio automático** — ao final, os metadados coletados são enviados via API para o sistema interno da DPERJ
5. **Administrável por leigos** — painel SaaS visual onde gestores configuram fluxos, perguntas e integrações sem código

### Público-alvo

**Usuários finais (assistidos):** Cidadãos do RJ sem condições de pagar advogado, atendidos via WhatsApp.

**Usuários administradores:** Gestores da DPERJ que configuram fluxos, perguntas e integrações via painel web sem precisar de conhecimento técnico.

### Serviços Cobertos

| Serviço | Exemplos de Casos |
|---|---|
| **Família e Pensão** | Pensão alimentícia, guarda de filhos, divórcio, inventário |
| **Trabalhista** | Demissão, FGTS, horas extras, assédio, acidente de trabalho |
| **INSS / Federal** | Aposentadoria, BPC/LOAS, auxílio-doença, benefícios negados |
| **Criminal** | Violência doméstica, defesa criminal, orientação à vítima |
| **Outros** | Aluguel, dívidas, consumidor, documentação, casos gerais |

### Princípios de Produto

- **Conversa natural** — a IA faz perguntas como uma atendente real, não como um formulário
- **Não repete o que já sabe** — extração de contexto evita perguntas redundantes
- **Privacidade por padrão** — LGPD aceita antes de qualquer dado ser coletado
- **Administrável** — fluxos, perguntas e APIs configuráveis pelo painel sem código
- **Multi-canal** — começa no WhatsApp, expansível para outros canais

### Roadmap

| Fase | Objetivo | Status |
|---|---|---|
| 1 | Engine LangGraph: triagem + coleta + RAG + persistência | ✅ MVP |
| 2 | Extração de contexto + perguntas dinâmicas por serviço | 🔄 próximo |
| 3 | API de encerramento → sistema interno DPERJ | 🔄 próximo |
| 4 | WhatsApp Business API (Meta Cloud) | 📋 planejado |
| 5 | Painel admin SaaS (builder visual de fluxos) | 📋 planejado |
| 6 | Multi-tenant — expansão para outras Defensorias | 📋 futuro |

---

---

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20 + TypeScript (ESM/NodeNext) |
| Orquestração | LangGraph JS `^1.3.7` |
| IA / LLM | AWS Bedrock — Claude 3 Haiku via `ChatBedrockConverse` |
| RAG | Bedrock Knowledge Base (S3 Vectors + Titan Embed v2) |
| Persistência | SQLite via `SqliteSaver` (`data/checkpoints.db`) |
| Servidor | Express v5 |
| Frontend | HTML/JS vanilla em `public/index.html` (estilo WhatsApp) |
| Package manager | pnpm |

---

## Comandos

```bash
pnpm server        # inicia servidor Express em http://localhost:3000
pnpm studio        # abre LangGraph Studio (visualiza grafo)
pnpm build         # compila TypeScript
```

---

## Variáveis de Ambiente (`.env`)

```
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=anthropic.claude-3-haiku-20240307-v1:0
BEDROCK_KB_ID=LF04FDVIYP
BEDROCK_KB_DS_ID=V6AOSMT9CQ
LANGSMITH_API_KEY=
```

`.env` está no `.gitignore` — nunca commitar.

---

## Estrutura de Pastas

```
src/
  graph.ts          ← grafo principal compilado + SqliteSaver checkpointer
  state.ts          ← GraphAnnotation (messages, lgpdAceito, categoria, dadosColetados)
  server.ts         ← Express: POST /api/chat com lógica de resume
  nodes/
    onboarding/     ← saudacao.ts | lgpd.ts | primeira-mensagem.ts
    atendimento/    ← triagem.ts (RAG) | informativo.ts (RAG) | encerramento.ts
    coleta/         ← dados-pessoais.ts | dados-residenciais.ts | dados-contato.ts
  services/
    familia-pensao/ ← graph.ts (subgrafo)
    trabalhista/    ← graph.ts (subgrafo)
    inss/           ← graph.ts (subgrafo)
    outros/         ← graph.ts (subgrafo)
docs/
  servicos.md       ← descrição dos serviços para o KB (upload S3)
  guia-linguagem.md ← guia de tom/linguagem da DPERJ para o KB (a preencher)
data/
  checkpoints.db    ← SQLite, gitignored
```

---

## Fluxo de Conversa

```
__start__
  └─ saudacao → lgpd [INTERRUPT] → lgpd_processar
                  ├─ lgpd_recusado → encerramento → __end__
                  └─ primeira_mensagem [INTERRUPT] → triagem
                        └─ informativo → (serviço)
                              └─ dados_pessoais [INTERRUPT]
                                   └─ dados_residenciais [INTERRUPT]
                                        └─ dados_contato [INTERRUPT]
                                             └─ encerramento → __end__
```

**Serviços disponíveis:** `familia_pensao` | `trabalhista` | `inss_federal` | `penal` | `outros`

`penal` redireciona para o subgrafo `outros` (DPERJ não atende criminal diretamente).

---

## Padrão de Multi-turn (IMPORTANTE)

O grafo usa `interruptAfter` para pausar entre turnos. O servidor **não pode** usar `graph.invoke(input, config)` em threads existentes — isso reinicia o grafo do zero.

**Padrão correto de resume:**
```typescript
// 1ª chamada (thread novo):
await graph.invoke({}, config);

// Chamadas seguintes (resume após interrupt):
await graph.updateState(config, { messages: [new HumanMessage(message)] });
await graph.invoke(null, config);
```

Lógica no `server.ts`: se `prevLen > 0` → usa updateState + invoke(null). Caso contrário → invoke({}).

---

## Tipos de Mensagem Customizados (frontend)

O frontend interpreta content blocks além de `text`:

```typescript
{ type: "boolean", trueLabel: true, falseLabel: false }  // botão Sim/Não
{ type: "image_url", image_url: { url: "..." } }          // imagem
{ type: "text", text: "..." }                              // texto normal
```

---

## RAG — Knowledge Base

`triagem.ts` e `informativo.ts` usam `AmazonKnowledgeBaseRetriever` (top 3 docs) para:
- **triagem**: busca descrições dos serviços → classifica com mais precisão
- **informativo**: busca guia de linguagem → responde alinhado ao tom da DPERJ

**Para atualizar o KB após editar documentos em `docs/`:**
```bash
aws s3 cp docs/servicos.md s3://maria-ia-kb-docs/
aws s3 cp docs/guia-linguagem.md s3://maria-ia-kb-docs/
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id LF04FDVIYP \
  --data-source-id V6AOSMT9CQ \
  --region us-east-1
```

---

## Adicionar Novo Tipo de Serviço

1. Criar `src/services/<nome>/graph.ts` (copiar de `outros/graph.ts`)
2. Adicionar categoria em `triagemRoute` em `triagem.ts`
3. Adicionar edge em `informativo` conditional em `graph.ts`
4. Adicionar `.addNode` e `.addEdge` em `graph.ts`
5. Atualizar `docs/servicos.md` com descrição do novo serviço + sincronizar KB

---

## Recursos AWS

| Recurso | Nome / ID |
|---|---|
| S3 documentos | `maria-ia-kb-docs` |
| S3 Vectors bucket | `maria-ia-kb-vectors` |
| S3 Vectors index | `maria-ia-index` (1024 dims, cosine) |
| Bedrock KB | `LF04FDVIYP` |
| KB Data Source | `V6AOSMT9CQ` |
| IAM Role KB | `maria-ia-kb-role` |
| Imagem Maria | `https://maria-ia.s3.us-east-1.amazonaws.com/maria-ia.webp` |

---

## O Que Está TODO

- [ ] Perguntas reais nos nodes `coleta/` (CPF, nome, endereço, telefone, e-mail)
- [ ] Perguntas específicas nos 4 subgrafos de serviço
- [ ] Preencher `docs/guia-linguagem.md` com diretrizes reais da DPERJ e re-sincronizar KB
- [ ] Salvar `dadosColetados` em banco/API no encerramento (Opção B de persistência)
- [ ] Validação de CPF, telefone, CEP
- [ ] Busca automática de endereço via ViaCEP (CEP → rua, bairro, cidade)
- [ ] Migrar checkpointer SQLite → DynamoDB para produção
