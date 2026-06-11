# Plano de Implementação — Maria Chat

Blueprint técnico para a IA completar o produto fase a fase.
Leia junto com `CLAUDE.md` que descreve o estado atual do código.

---

## Stack Completo

### Visão Geral da Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                        USUÁRIOS                              │
│   WhatsApp ──► Webhook   |   Admin ──► Frontend (Vite)      │
└──────────────────┬──────────────────────┬───────────────────┘
                   │                      │
┌──────────────────▼──────────────────────▼───────────────────┐
│                    BACKEND (Fastify)                          │
│  /webhook/whatsapp  |  /api/chat  |  /admin/*  |  /auth/*   │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │         LangGraph Engine (AI Orchestration)          │    │
│  │  Grafo Principal → Subgrafos de Serviço              │    │
│  │  Extrator de Contexto → Agentes especializados       │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────┬──────────────────────┬───────────────────────┘
               │                      │
┌──────────────▼───────┐  ┌───────────▼──────────────────────┐
│     PostgreSQL        │  │            AWS                    │
│  (conversas, fluxos,  │  │  Bedrock (Claude Haiku)          │
│   usuários, dados)    │  │  Bedrock KB (S3 Vectors + RAG)   │
└──────────────────────┘  │  S3 (docs, imagens)              │
                           └──────────────────────────────────┘
┌──────────────────────┐
│       Redis           │
│  (filas BullMQ,       │
│   sessions, cache)    │
└──────────────────────┘
```

### Backend — `backend/`

| Tecnologia | Versão | Função |
|---|---|---|
| **Node.js** | 22 LTS | Runtime |
| **TypeScript** | 5.x | Linguagem (ESM/NodeNext) |
| **Fastify** | 5.x | Servidor HTTP (mais rápido que Express, melhor TS) |
| **LangGraph JS** | ^1.3.7 | Orquestração de grafo conversacional |
| **@langchain/aws** | ^1.x | AWS Bedrock LLM + Knowledge Base |
| **Prisma** | 6.x | ORM para PostgreSQL |
| **BullMQ** | 5.x | Filas para retry de WhatsApp + chamadas API |
| **ioredis** | 5.x | Client Redis |
| **zod** | 4.x | Validação de schemas |
| **pnpm** | 10.x | Package manager |
| **tsx** | 4.x | Dev runner TypeScript |

### Frontend Admin — `frontend/`

| Tecnologia | Versão | Função |
|---|---|---|
| **Vite** | 6.x | Build tool + dev server |
| **React** | 19.x | Framework UI |
| **TypeScript** | 5.x | Linguagem |
| **Tailwind CSS** | 4.x | Estilização |
| **shadcn/ui** | latest | Componentes UI (Radix primitives) |
| **React Flow** | 12.x | Builder visual drag-and-drop de grafos |
| **Zustand** | 5.x | Estado global |
| **TanStack Query** | 5.x | Cache e sincronização de dados com API |
| **TanStack Router** | 1.x | Roteamento |
| **React Hook Form + Zod** | — | Formulários com validação |
| **Recharts** | 2.x | Gráficos de analytics |

### Banco de Dados

| Tecnologia | Função |
|---|---|
| **PostgreSQL 16** | Banco principal (fluxos, conversas, usuários) |
| **Redis 7** | Filas BullMQ + cache de sessões + rate limiting |

### AWS

| Serviço | Função |
|---|---|
| **Bedrock — Claude 3 Haiku** | LLM: triagem, extração, respostas naturais |
| **Bedrock Knowledge Base** | RAG: guia de linguagem + descrição de serviços |
| **S3 (maria-ia-kb-docs)** | Documentos do Knowledge Base |
| **S3 Vectors (maria-ia-kb-vectors)** | Embeddings (Titan Embed v2, 1024 dims) |

### Infra / Deploy

| Tecnologia | Função |
|---|---|
| **Docker + Docker Compose** | Ambiente local e produção |
| **Nginx** | Reverse proxy: frontend (80/443) + backend API |
| **GitHub Actions** | CI/CD |

---

## Contexto do Projeto

**Maria Chat** é uma plataforma de atendimento jurídico conversacional com IA para a Defensoria Pública do RJ (DPERJ). Canal principal: WhatsApp Business.

**Stack atual (MVP — código em `src/`, ver `CLAUDE.md` para detalhes):**
- LangGraph JS `^1.3.7` + `@langchain/aws` — engine conversacional + Bedrock
- AWS Bedrock Claude 3 Haiku — LLM via `ChatBedrockConverse`
- Bedrock Knowledge Base `LF04FDVIYP` — RAG com `AmazonKnowledgeBaseRetriever`
- SQLite `SqliteSaver` → `data/checkpoints.db` — persistência de checkpoints
- Express v5 — servidor REST em `src/server.ts`
- TypeScript ESM/NodeNext, pnpm 10

**O que migrar na Fase 5:** Express → Fastify, SQLite → PostgreSQL + `@langchain/langgraph-checkpoint-postgres`

**Padrão crítico de multi-turn (nunca mudar):**
```typescript
// Thread novo: invoke({}, config)
// Resume após interrupt: updateState + invoke(null, config)
// NUNCA usar invoke(input_nao_nulo, config) em thread existente — reinicia o grafo
```

**Estrutura atual:**
```
src/
  graph.ts          ← grafo principal
  state.ts          ← GraphAnnotation
  server.ts         ← Express POST /api/chat
  nodes/
    onboarding/     saudacao, lgpd, primeira-mensagem
    atendimento/    triagem (RAG), informativo (RAG), encerramento
    coleta/         dados-pessoais, dados-residenciais, dados-contato  [TODO]
  services/
    familia-pensao/ trabalhista/ inss/ outros/  [TODO: perguntas reais]
```

---

## Fase 2 — Extração de Contexto + Perguntas Dinâmicas

### Objetivo
A IA não deve fazer perguntas que o assistido já respondeu implicitamente na conversa.
Ex: assistido diz "meu marido não paga pensão para meus 2 filhos menores" → não perguntar "tem filhos?" nem "são menores?".

### Implementação

#### 2.1 — Agente Extrator de Contexto

Criar `src/nodes/atendimento/extrator.ts`:

```typescript
// Node que roda após cada mensagem do usuário
// Analisa state.messages e extrai campos para dadosColetados
// Usa LLM com structured output (Zod schema) para extrair entidades

// Campos globais a extrair de qualquer mensagem:
// nome, cpf, data_nascimento, telefone, email,
// cep, rua, numero, bairro, cidade,
// tem_filhos, filhos_menores, situacao_conjugal,
// descricao_caso (resumo livre)

// Campos específicos por serviço são definidos no subgrafo do serviço
```

O extrator deve:
1. Receber a última mensagem do usuário
2. Rodar LLM com system prompt de extração + schema Zod dos campos esperados
3. Fazer merge em `dadosColetados` (só sobrescrever se valor novo não for nulo)
4. Retornar `{ dadosColetados: { ...extraídos } }`

Inserir o extrator como node paralelo (usando `Send`) após cada interrupt, antes de processar a resposta.

#### 2.2 — Perguntas Dinâmicas por Serviço

Cada subgrafo de serviço deve ter uma lista de perguntas com metadados:

```typescript
interface Pergunta {
  chave: string;           // key em dadosColetados
  texto: string;           // pergunta em linguagem natural
  obrigatoria: boolean;
  tipo: "texto" | "sim_nao" | "opcoes" | "cpf" | "telefone" | "cep";
  opcoes?: string[];       // para tipo "opcoes"
}

const PERGUNTAS_FAMILIA: Pergunta[] = [
  { chave: "tipo_acao", texto: "Você quer pedir pensão alimentícia, guarda, divórcio ou outro?", obrigatoria: true, tipo: "opcoes", opcoes: ["pensão", "guarda", "divórcio", "outro"] },
  { chave: "tem_filhos", texto: "Você tem filhos?", obrigatoria: true, tipo: "sim_nao" },
  { chave: "filhos_menores", texto: "Algum filho é menor de 18 anos?", obrigatoria: false, tipo: "sim_nao" },
  // ... até ~50 perguntas por serviço
];
```

O node do serviço deve:
1. Verificar quais perguntas obrigatórias ainda estão sem resposta em `dadosColetados`
2. Formular a próxima pergunta em linguagem natural (via LLM com contexto da conversa)
3. Se todas respondidas → sinalizar conclusão e avançar para `dados_pessoais`

#### 2.3 — State: adicionar campos novos

Atualizar `src/state.ts`:

```typescript
export const GraphAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  lgpdAceito:      Annotation<boolean>(...),
  categoria:       Annotation<string>(...),
  dadosColetados:  Annotation<Record<string, string>>(...),  // merge strategy
  perguntasFeitas: Annotation<string[]>({                    // chaves já perguntadas
    value: (a, b) => [...new Set([...a, ...b])],
    default: () => [],
  }),
  servicoConcluido: Annotation<boolean>({ value: (_, b) => b, default: () => false }),
});
```

---

## Fase 3 — API de Encerramento → Sistema DPERJ

### Objetivo
Ao final da conversa (após `dados_contato`), enviar todos os metadados coletados para a API interna da DPERJ para abertura automática do processo.

### Implementação

#### 3.1 — Node `enviar_dados`

Criar `src/nodes/atendimento/enviar-dados.ts`:

```typescript
// Formata dadosColetados + categoria + metadados da conversa
// POST para process.env.DPERJ_API_URL com auth via process.env.DPERJ_API_KEY
// Em caso de erro: salva em fila local (SQLite) para retry
// Retorna confirmação com número do protocolo

interface PayloadDPERJ {
  protocolo?: string;
  canal: "whatsapp" | "web";
  categoria: string;
  timestamp_inicio: string;
  timestamp_fim: string;
  dados_pessoais: {
    nome?: string;
    cpf?: string;
    data_nascimento?: string;
    telefone?: string;
    email?: string;
  };
  dados_residenciais: {
    cep?: string;
    rua?: string;
    numero?: string;
    bairro?: string;
    cidade?: string;
    estado?: string;
  };
  dados_caso: Record<string, string>;  // campos específicos do serviço
}
```

Inserir entre `dados_contato` e `encerramento` no `graph.ts`.

#### 3.2 — Encerramento com protocolo

`encerramento.ts` deve receber o número de protocolo retornado pela API e incluir na mensagem final:
> "Seu atendimento foi registrado com o protocolo **#2024-00123**. Entraremos em contato em breve pelo telefone informado. Se precisar de ajuda, ligue **129**."

---

## Fase 4 — WhatsApp Business API

### Objetivo
Receber e enviar mensagens via Meta WhatsApp Business Cloud API, sem necessidade de o assistido abrir um navegador.

### Implementação

#### 4.1 — Webhook Meta

Criar `src/channels/whatsapp.ts`:

```typescript
// GET /webhook/whatsapp — verificação do webhook (challenge)
// POST /webhook/whatsapp — receber mensagens

// Converter formato Meta → formato interno:
// { from: "5521999990000", text: "oi" } → { sessionId: from, message: text }

// Converter formato interno → formato Meta:
// AIMessage com content array → múltiplas mensagens WhatsApp
// type "boolean" → botões interativos (interactive/button)
// type "image_url" → message type "image"
// type "text" → message type "text"
```

#### 4.2 — Sender WhatsApp

```typescript
async function sendWhatsApp(to: string, messages: AIMessage[]) {
  for (const msg of messages) {
    const payload = toWhatsAppPayload(msg);
    await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
      body: JSON.stringify(payload),
    });
  }
}
```

#### 4.3 — Variáveis de Ambiente adicionais

```
WA_PHONE_NUMBER_ID=
WA_ACCESS_TOKEN=
WA_WEBHOOK_VERIFY_TOKEN=
DPERJ_API_URL=
DPERJ_API_KEY=
```

---

## Fase 5 — Painel Admin SaaS (Builder Visual)

### Objetivo
Interface web onde gestores da DPERJ (sem conhecimento técnico) podem:
- Criar e editar fluxos de conversa
- Gerenciar perguntas por serviço (adicionar, reordenar, marcar obrigatória)
- Configurar endpoints de API externos
- Ver analytics de conversas (volume, taxa de conclusão, abandono por etapa)
- Gerenciar usuários administradores

### Stack do Painel Admin

```
frontend/          (pasta raiz: frontend/)
  Build tool:  Vite 6
  Framework:   React 19 + TypeScript
  UI:          Tailwind CSS 4 + shadcn/ui
  Flow builder: React Flow 12 (drag-and-drop visual)
  Estado:      Zustand 5
  API client:  TanStack Query 5
  Roteamento:  TanStack Router 1
  Forms:       React Hook Form + Zod
  Charts:      Recharts 2

backend/           (migração do src/ atual)
  Servidor:    Fastify 5 (substituir Express)
  Auth:        JWT + refresh token (fastify-jwt)
  ORM:         Prisma 6
  Banco:       PostgreSQL 16 (substituir SQLite)
  Filas:       BullMQ 5 + Redis 7
```

### Estrutura do Builder Visual

Cada nó no React Flow corresponde a um node do LangGraph:

```
Tipos de nó:
  [Mensagem]       ← envia texto/imagem/botão
  [Pergunta]       ← aguarda resposta, salva em dadosColetados
  [Condição]       ← edge condicional baseado em campo do estado
  [IA Livre]       ← node com LLM (system prompt configurável)
  [Chamada API]    ← POST/GET para endpoint externo
  [Subgrafo]       ← referência a outro fluxo (recursivo)
  [Atribuir campo] ← escreve valor fixo em dadosColetados
  [Encerrar]       ← finaliza conversa e envia dados
```

O painel salva o fluxo como JSON no banco. O engine LangGraph lê o JSON e monta o grafo dinamicamente em tempo de execução.

### Schema do Banco (Prisma)

```prisma
model Organization {
  id        String   @id @default(cuid())
  name      String
  flows     Flow[]
  users     User[]
}

model Flow {
  id        String   @id @default(cuid())
  name      String
  orgId     String
  nodes     Json     // array de FlowNode
  edges     Json     // array de FlowEdge
  active    Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Conversation {
  id           String   @id @default(cuid())
  sessionId    String   @unique
  channel      String   // "whatsapp" | "web"
  flowId       String
  status       String   // "active" | "completed" | "abandoned"
  categoria    String?
  dadosColetados Json   @default("{}")
  protocoloDperj String?
  startedAt    DateTime @default(now())
  completedAt  DateTime?
}

model User {
  id       String @id @default(cuid())
  email    String @unique
  password String
  role     String // "admin" | "viewer"
  orgId    String
}
```

### Geração Dinâmica do Grafo LangGraph

```typescript
// src/engine/builder.ts
// Recebe um Flow do banco e compila para um CompiledStateGraph

function buildGraphFromFlow(flow: Flow): CompiledStateGraph {
  const builder = new StateGraph(GraphAnnotation);

  for (const node of flow.nodes) {
    builder.addNode(node.id, createNodeFunction(node));
  }

  for (const edge of flow.edges) {
    if (edge.condition) {
      builder.addConditionalEdges(edge.source, buildCondition(edge.condition));
    } else {
      builder.addEdge(edge.source, edge.target);
    }
  }

  return builder.compile({
    checkpointer: postgresSaver,  // PostgresSaver na Fase 5, SqliteSaver no dev
    interruptAfter: flow.nodes
      .filter((n) => n.type === "pergunta")
      .map((n) => n.id),
  });
}
```

---

## Fase 6 — Multi-tenant

### Objetivo
Expandir para outras Defensorias estaduais ou órgãos públicos como produto SaaS.

### Requisitos
- Cada organização tem seus próprios fluxos, usuários e dados isolados (RLS no PostgreSQL)
- Subdomínio por organização: `dperj.mariachat.com.br`, `dpsp.mariachat.com.br`
- Planos (free, pro, enterprise) com limites de conversas/mês
- Billing integrado (Stripe)

---

## Ordem de Implementação Recomendada

```
[✅] Fase 1: Engine base (concluída)
[🔄] Fase 2a: Extrator de contexto (nodes/atendimento/extrator.ts)
[🔄] Fase 2b: Perguntas reais nos subgrafos de serviço
[🔄] Fase 2c: Perguntas reais nos nodes de coleta
[📋] Fase 3: Node enviar-dados + integração DPERJ API
[📋] Fase 4: WhatsApp webhook + sender
[📋] Fase 5a: Backend admin API (Fastify + Prisma + PostgreSQL)
[📋] Fase 5b: Frontend React Flow builder
[📋] Fase 5c: Analytics dashboard
[📋] Fase 6: Multi-tenant + billing
```

---

## Decisões Arquiteturais

| Decisão | Escolha | Motivo |
|---|---|---|
| Grafo dinâmico vs estático | Estático agora, dinâmico na Fase 5 | Evitar complexidade prematura |
| WhatsApp vs Web | WhatsApp na Fase 4, Web já funciona | Canal principal da DPERJ |
| SQLite vs PostgreSQL | SQLite até Fase 5, migrar para Postgres | Zero infra para dev |
| MemorySaver vs SqliteSaver | SqliteSaver (atual) | Persiste entre restarts |
| LLM model | Claude 3 Haiku | Custo baixo, velocidade, qualidade suficiente |
| Embeddings | Titan Embed v2 (1024 dims, cosine) | AWS-native, sem custo adicional de infra |
