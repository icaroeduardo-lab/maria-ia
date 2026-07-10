# Graph Report - .  (2026-07-09)

## Corpus Check
- 118 files · ~58,237 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 699 nodes · 1248 edges · 47 communities (41 shown, 6 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 58 edges (avg confidence: 0.81)
- Token cost: 0 input · 314,112 output

## Community Hubs (Navigation)
- LangGraph Engine Core
- Cache & Config Engine
- Assistidos & KYC API
- Auth & Admin API
- WhatsApp Channel & Payloads
- Package Metadata
- Biome Lint Config
- NPM Dependencies
- CLAUDE.md Doc Index
- Processos PDPJ API
- Ficha PDF Generation
- TypeScript Config
- Fluxo Categorizado (Legacy)
- OpenAPI Endpoints
- LGPD & Segurança
- Casos de Uso — Admin
- Deploy AWS v2 Infra
- Casos de Uso — Cidadão
- Cache de Reescrita & Tom
- Bedrock KB & Guia Linguagem
- Flow Builder Engine
- Máquina de Estados & Requisitos
- Multi-tenant Plano
- Multi-turn Pattern & Queue
- Guia Frontend & CI Tests
- Casos de Uso — Ops DPERJ
- DB Deploy (Railway/Supabase)
- Terraform Infra Readme
- WhatsApp Go-Live Requirements
- Serviços — Categorias DPERJ
- Upload Imagem
- PDPJ Processos (Staging)
- Consulta Processo Flow
- Terraform Rationale
- Sequência — Onboarding/Encerramento
- Extrator Contexto (Fase 2)
- Prisma Models — Assistido/User
- Prisma Seed
- Scripts Export Flows
- Chat Web UI
- Decisões Arquiteturais
- Fase 3 — API DPERJ
- Fase 4 — WhatsApp
- Resumo Service (Processo)
- Diagrama de Classes
- Prisma Config Model
- Chat Web Module

## God Nodes (most connected - your core abstractions)
1. `CLAUDE.md (project context doc)` - 51 edges
2. `env` - 26 edges
3. `scripts` - 16 edges
4. `criarNode()` - 16 edges
5. `Maria Chat API (OpenAPI spec)` - 16 edges
6. `montarApp()` - 15 edges
7. `buildGraphFromFlow()` - 15 edges
8. `Pergunta` - 15 edges
9. `compilerOptions` - 15 edges
10. `adminRoutes()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `Content blocks do chat (text, image_url, boolean, options, cta_url)` --semantically_similar_to--> `CLAUDE.md (project context doc)`  [INFERRED] [semantically similar]
  docs/guia-frontend.md → CLAUDE.md
- `adminRoutes()` --indirect_call--> `config()`  [INFERRED]
  src/api/routes/admin.ts → test/fluxo.test.ts
- `adminRoutes()` --indirect_call--> `corpo()`  [INFERRED]
  src/api/routes/admin.ts → test/whatsapp.test.ts
- `Identidade da Maria (assistente virtual DPERJ)` --semantically_similar_to--> `Maria Chat (product)`  [INFERRED] [semantically similar]
  docs/guia-linguagem.md → CLAUDE.md
- `DperjFila (entidade Prisma)` --conceptually_related_to--> `src/dperj.ts (cliente API DPERJ + fila retry)`  [AMBIGUOUS]
  docs/diagrama-classes.md → CLAUDE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Fluxo de atendimento ao cidadão (WhatsApp/web)** — docs_casos_de_uso_cidadao, docs_casos_de_uso_whatsapp_meta, docs_casos_de_uso_pdpj, claude_dperj, docs_casos_de_uso_bedrock_transcribe, docs_casos_de_uso_uc01_iniciar_atendimento, docs_casos_de_uso_uc06_descrever_caso_triagem, docs_casos_de_uso_uc10_receber_protocolo [INFERRED 0.85]
- **Pipeline API→SQS→Worker de processamento de mensagem** — src_api_server_ts_module, src_core_queue_ts_module, src_worker_worker_ts_module, claude_bedrock_kb, docs_diagramas_sequencia_msg_texto_flow [INFERRED 0.85]
- **Camada de serviços do engine (ChatService/GraphBuilder/Extrator/ProcessosClient/ResumoService/Masker/DperjClient)** — src_chat_ts_chatservice, src_engine_builder_ts_graphbuilder, src_engine_ia_ts_extrator, src_processos_ts_processosclient, src_resumo_ts_resumoservice, src_mask_ts_masker, src_dperj_ts_dperjclient [EXTRACTED 1.00]
- **Fluxo de confirmação de identidade (KYC)** — public_kyc_confirmacao_identidade, docs_maquina_estados_kyc_subfluxo, docs_lgpd_seguranca_kyc_biometria, docs_openapi_api_kyc_captura, docs_requisitos_modulo_lgpd_identidade [INFERRED 0.85]
- **Fluxo de consulta de processos PDPJ** — docs_pdpj_processos_api, docs_maquina_estados_pdpj_subfluxo, docs_openapi_api_processos_consultar, docs_openapi_api_processos_resumo, docs_requisitos_modulo_casos_processos [INFERRED 0.85]
- **Requisitos para WhatsApp entrar em produção** — docs_whatsapp_token_permanente_system_user, docs_whatsapp_verificacao_negocio_business_verification, docs_requisitos_modulo_whatsapp_canal [INFERRED 0.80]

## Communities (47 total, 6 thin omitted)

### Community 0 - "LangGraph Engine Core"
Cohesion: 0.07
Nodes (49): DESTINOS_ROTEADOR, encerramento(), CAMPOS_CASO, casarOpcao(), extrator(), GLOBAIS_SIM_NAO, model, montarSchema() (+41 more)

### Community 1 - "Cache & Config Engine"
Cohesion: 0.07
Nodes (49): cacheGet(), cacheSet(), getMem(), memoria, setMem(), ConfigIA, obterConfig(), obterEstilo() (+41 more)

### Community 2 - "Assistidos & KYC API"
Cohesion: 0.07
Nodes (42): __dirname, montarApp(), MontarAppOpts, assistidosFlowRoutes(), CAMPOS, dadosPublicos(), extrairCampos(), so_digitos() (+34 more)

### Community 3 - "Auth & Admin API"
Cohesion: 0.10
Nodes (32): adminRoutes(), autenticar(), authRoutes(), exigirAdmin(), @fastify/jwt, FastifyJWT, UsuarioJWT, invokeComRetry() (+24 more)

### Community 4 - "WhatsApp Channel & Payloads"
Cohesion: 0.10
Nodes (32): Bloco, formatar(), toWhatsAppPayloads(), truncar(), API_VERSION(), enviarWhatsApp(), extrairMensagens(), GRAPH_URL() (+24 more)

### Community 5 - "Package Metadata"
Cohesion: 0.06
Nodes (35): author, description, devDependencies, @biomejs/biome, prisma, tsx, @types/node, @types/pg (+27 more)

### Community 6 - "Biome Lint Config"
Cohesion: 0.06
Nodes (31): noForEach, files, includes, formatter, enabled, indentStyle, indentWidth, lineWidth (+23 more)

### Community 7 - "NPM Dependencies"
Cohesion: 0.08
Nodes (24): dependencies, @aws-sdk/client-comprehend, @aws-sdk/client-s3, @aws-sdk/client-sqs, @aws-sdk/client-transcribe, bcryptjs, dotenv, fastify (+16 more)

### Community 8 - "CLAUDE.md Doc Index"
Cohesion: 0.12
Nodes (22): CLAUDE.md (project context doc), Fila de retry de envio à DPERJ, Extrator anti-alucinação (mitigação de chutes do Haiku), docs/servicos.md (conteúdo do KB), packages/core (engine compartilhado, target), nodes/atendimento/encerramento.ts, nodes/atendimento/enviar-dados.ts (POST DPERJ), nodes/atendimento/extrator.ts (structured output Zod) (+14 more)

### Community 9 - "Processos PDPJ API"
Cohesion: 0.19
Nodes (18): processosRoutes(), achatar(), BASE(), buscar(), consultarPorCpf(), consultarPorNumero(), fmtDataHora(), listaNumerada() (+10 more)

### Community 10 - "Ficha PDF Generation"
Cohesion: 0.22
Nodes (15): bgCache, BUCKET, escapar(), extrairDados(), fichaRoutes(), fmtData(), fundo(), gerarFicha() (+7 more)

### Community 11 - "TypeScript Config"
Cohesion: 0.11
Nodes (17): compilerOptions, declaration, declarationMap, esModuleInterop, lib, module, moduleResolution, outDir (+9 more)

### Community 12 - "Fluxo Categorizado (Legacy)"
Cohesion: 0.12
Nodes (17): docs/fluxo-categorizado.md (mapeamento do fluxo legado), API legada: Atualizar Pessoa (PUT /pessoa), API legada: Cadastrar Pessoa (POST /pessoa), API legada: Consultar CEP, Regra DDD RJ (5521/5522/5524 permitidos, demais → humano), Nó proposto: [cadastro], Nó proposto: [dados_contato], Nó proposto: [dados_pessoais] (+9 more)

### Community 13 - "OpenAPI Endpoints"
Cohesion: 0.13
Nodes (17): /admin/assistidos CRUD, /admin/config, /admin/users, /admin/analytics, /admin/audit, /admin/conversations list/detalhe/histórico/revelar, /admin/flows CRUD + validar + activate, POST /admin/upload, POST /api/casos/consultar, POST /api/ficha, POST /api/kyc/iniciar (+9 more)

### Community 14 - "LGPD & Segurança"
Cohesion: 0.15
Nodes (14): DPERJ como Controlador (LGPD art. 5º), Encarregado (DPO) — a designar, Biometria sensível — selfie do KYC (art. 11), LGPD e Segurança da Informação (documento), Medidas de segurança implementadas (art. 46), Operador — fornecedor/plataforma Maria Chat, Retenção indefinida da Conversation — ação pendente, Suboperadores (AWS, Meta, PDPJ, Stripe) (+6 more)

### Community 15 - "Casos de Uso — Admin"
Cohesion: 0.19
Nodes (14): Ator: Gestor (admin), Ator: Operador (viewer), Ator secundário: Stripe, Ator: Superadmin, UC-20 Autenticar no painel, UC-21 Construir/editar fluxo, UC-22 Validar e ativar fluxo, UC-23 Ver conversas (+6 more)

### Community 16 - "Deploy AWS v2 Infra"
Cohesion: 0.18
Nodes (13): Dockerfile.api (imagem do serviço api), Dockerfile.worker (imagem do serviço worker), docs/arquitetura-maria.drawio (diagrama de arquitetura), docs/deploy-aws-v2.md (deploy AWS Fargate v2), Meta exige webhook HTTPS válido → ACM+Route53 no ALB, docs/STRUCTURE.md (arquitetura-alvo AWS), services/api (target: Fastify webhook + /admin + /api/chat + /health), services/worker (target: consumidor SQS) (+5 more)

### Community 17 - "Casos de Uso — Cidadão"
Cohesion: 0.19
Nodes (13): Ator secundário: Bedrock/Transcribe, Ator: Cidadão, UC-01 Iniciar atendimento, UC-02 Aceitar/recusar LGPD, UC-03 Enviar mensagem de voz, UC-04 Identificar-se por CPF, UC-05 Confirmar identidade (KYC), UC-06 Descrever o caso (triagem) (+5 more)

### Community 18 - "Cache de Reescrita & Tom"
Cohesion: 0.21
Nodes (12): docs/estrategia-reescrita-cache-tom.md, Cache de reescrita (chave flowId:nodeId:tom:styleVersion), Amazon Comprehend (DetectSentiment por turno, opcional), Skip-gate/extração (decide SE pergunta), Tom por sentimento (1x no relato, fundido no classify+extração), Skip-gate (pergunta cuja chave já preenchida é pulada), infra/terraform/elasticache.tf (ElastiCache Redis), src/core/cache.ts (store memória → Redis) (+4 more)

### Community 19 - "Bedrock KB & Guia Linguagem"
Cohesion: 0.22
Nodes (11): Bedrock Knowledge Base (LF04FDVIYP), Maria Chat (product), Nó proposto: [informativo], Nó proposto: [menu], docs/guia-linguagem.md (guia de tom/linguagem), Protocolo crise emocional (pausar fluxo, CVV 188), Identidade da Maria (assistente virtual DPERJ), Regras de tom de voz (acolhedor, simples, humano, respeitoso, objetivo) (+3 more)

### Community 20 - "Flow Builder Engine"
Cohesion: 0.22
Nodes (11): Conversation (entidade Prisma), Flow (entidade Prisma), ChatService (serviço), FlowEdge (tipo), FlowJSON (tipo), FlowNode (tipo), GraphBuilder (serviço), NodeData (tipo) (+3 more)

### Community 21 - "Máquina de Estados & Requisitos"
Cohesion: 0.22
Nodes (10): Ciclo de vida da Conversation (active/completed/abandoned), Retry de envio à DPERJ (fila), Macro-fluxo do atendimento (fluxo DPERJ completo), Subfluxo Acompanhar Processo (PDPJ), Documento de Requisitos (RF/RNF/RN), Módulo Casos/Processos (RF-16..17, RNF-06, RN-05), Módulo Encerramento/DPERJ (RF-18..20, RNF-06), RNF Desempenho e escala (RNF-01..04, ~1,5M msg/mês) (+2 more)

### Community 22 - "Multi-tenant Plano"
Cohesion: 0.22
Nodes (10): Estado atual: schema single-tenant (sem orgId), Plano para virar multi-tenant (Organization + orgId + escopo), Desvio: checkpoints movidos para schema langgraph (Fase 6, evita drift Prisma), Desvio: fila DPERJ em SQLite, não BullMQ (Fase 5), Desvio: isolamento em nível de aplicação, não RLS nativo (Fase 6), Fase 5: Painel Admin SaaS (Builder Visual), Schema do Banco (Prisma) — blueprint Fase 5 (Organization/Flow/Conversation/User), Fase 6: Multi-tenant (+2 more)

### Community 23 - "Multi-turn Pattern & Queue"
Cohesion: 0.22
Nodes (9): Namespacing de thread_id multi-tenant, Padrão crítico de multi-turn (interruptAfter + Saver), Sequência: mensagem de texto → resposta, SQS FIFO com MessageGroupId=sessionId (ordem por conversa, sem concorrência), src/chat.ts (processarMensagem), src/core/queue.ts (produtor/consumidor SQS FIFO), src/graph.ts (grafo principal + SqliteSaver), src/server.ts (Fastify server) (+1 more)

### Community 24 - "Guia Frontend & CI Tests"
Cohesion: 0.22
Nodes (9): docs/guia-frontend.md (spec do painel admin), Lacuna: autosave/lock de edição (dois editores se sobrescrevem), Content blocks do chat (text, image_url, boolean, options, cta_url), Schema JSON do flow {nodes, edges} (builder visual), Lacuna: versionamento de flow (sem rollback/draft), docs/openapi.yaml (OpenAPI spec), CI job: test (lint, typecheck, tests), test/fluxo.test.ts (integração multi-turn) (+1 more)

### Community 25 - "Casos de Uso — Ops DPERJ"
Cohesion: 0.29
Nodes (7): DPERJ — Defensoria Pública do Estado do Rio de Janeiro, docs/casos-de-uso.md (atores e casos de uso), Ator: Agendador, UC-10 Receber protocolo/encerramento, UC-40 Reprocessar fila DPERJ, UC-41 Expirar conversas/dados, UC-42 Monitorar saúde do token

### Community 26 - "DB Deploy (Railway/Supabase)"
Cohesion: 0.29
Nodes (7): docs/deploy.md (deploy Railway, WhatsApp 24/7), Usar conexão direta 5432, não pooler 6543 (pgbouncer transaction mode quebra prepared statements do Prisma), Railway (host recomendado), Postgres no Supabase (opcional), packages/db (Prisma schema + client, target), prisma/schema.prisma (schema module), src/db.ts (Prisma client)

### Community 27 - "Terraform Infra Readme"
Cohesion: 0.29
Nodes (7): Transferência internacional de dados (art. 33, EUA), Infra Terraform — arquitetura-alvo AWS (ECS Fargate + SQS + EventBridge), CI/CD via GitHub OIDC (github_oidc.tf, ci.yml), Fase 2: SQS FIFO + ALB + IAM + ECS (api/worker), Fase 3: EventBridge — jobs agendados (retry DPERJ, limpeza, health), Fase 4: Observability (SNS, alarmes, dashboard, VPC endpoints), RDS PostgreSQL + RDS Proxy (Fase 0-1)

### Community 28 - "WhatsApp Go-Live Requirements"
Cohesion: 0.33
Nodes (7): Ambiente de produção PDPJ — não usar agora, Módulo WhatsApp/Canal (RF-01..06, RNF-04,07), Aplicar token permanente no Railway (WA_ACCESS_TOKEN), System User — token WhatsApp permanente, Verificação de Negócio (Business Verification) da DPERJ, Registro do número de telefone oficial da DPERJ, Limites de mensagem por tier (1k→10k→100k→ilimitado)

### Community 29 - "Serviços — Categorias DPERJ"
Cohesion: 0.29
Nodes (7): Módulo Triagem/Coleta (RF-11..15, RNF-03,23,24), Serviços da DPERJ (documento de categorias), familia_pensao — Direito de Família e Pensão Alimentícia, inss_federal — INSS e Justiça Federal (DPU), outros — Outros Casos e Orientação Geral, penal — Direito Penal e Criminal, trabalhista — Direito do Trabalho

### Community 30 - "Upload Imagem"
Cohesion: 0.33
Nodes (6): Parsing de respostas interativas do WhatsApp (por id), POST /admin/upload (upload de imagem p/ nós de fluxo), src/api/server.ts (entrada v2), src/channels/whatsapp.ts (webhook + sender), src/routes/admin.ts (/admin routes), src/routes/auth.ts (POST /auth/login)

### Community 31 - "PDPJ Processos (Staging)"
Cohesion: 0.33
Nodes (6): API de Processos PDPJ (Data Lake/PJe), Ambiente de testes (staging) — em uso, Regras de negócio (RN-01..05), consultarPorCpf, consultarPorNumero, resumirProcesso

### Community 32 - "Consulta Processo Flow"
Cohesion: 0.40
Nodes (5): Ator secundário: PDPJ, UC-08 Acompanhar processo, Sequência: consulta de processo (PDPJ + resumo IA), ProcessosClient (serviço), ProcessoSimples (tipo)

### Community 33 - "Terraform Rationale"
Cohesion: 0.40
Nodes (5): Preenchimento dos segredos (Secrets Manager placeholders → valores reais), infra/terraform (IaC target layout), RDS dedicado + RDS Proxy (pooling p/ muitas tasks), Terraform escolhido sobre CloudFormation (módulos, plan, ecossistema), CI job: terraform fmt/validate

### Community 34 - "Sequência — Onboarding/Encerramento"
Cohesion: 0.50
Nodes (5): docs/diagramas-sequencia.md (diagramas de sequência), Sequência: encerramento → envio à DPERJ (com fila retry), Sequência: onboarding LGPD → CPF → KYC facial, DperjFila (entidade Prisma), DperjClient (serviço)

### Community 35 - "Extrator Contexto (Fase 2)"
Cohesion: 0.40
Nodes (5): Visão geral da arquitetura (blueprint), Fase 2: Agente Extrator de Contexto, Fase 2: Perguntas Dinâmicas por Serviço, src/nodes/atendimento/extrator.ts, GraphAnnotation (src/state.ts)

### Community 36 - "Prisma Models — Assistido/User"
Cohesion: 0.40
Nodes (5): Assistido (entidade Prisma), AuditLog (entidade Prisma), Caso (entidade Prisma), User (entidade Prisma), Masker (serviço)

### Community 37 - "Prisma Seed"
Cohesion: 0.40
Nodes (4): __dirname, flows, FlowSeed, prisma

### Community 38 - "Scripts Export Flows"
Cohesion: 0.40
Nodes (4): destino, __dirname, prisma, seed

### Community 39 - "Chat Web UI"
Cohesion: 0.50
Nodes (3): POST /api/chat, addBubble(), sendMessage()

### Community 40 - "Decisões Arquiteturais"
Cohesion: 0.67
Nodes (3): Decisão: Claude 3 Haiku — custo baixo, velocidade, qualidade suficiente, Decisão: SQLite até Fase 5, migrar p/ Postgres — zero infra para dev, Decisões Arquiteturais (tabela)

## Ambiguous Edges - Review These
- `src/dperj.ts (cliente API DPERJ + fila retry)` → `DperjFila (entidade Prisma)`  [AMBIGUOUS]
  docs/diagrama-classes.md · relation: conceptually_related_to
- `Estado atual: schema single-tenant (sem orgId)` → `Schema do Banco (Prisma) — blueprint Fase 5 (Organization/Flow/Conversation/User)`  [AMBIGUOUS]
  docs/multi-tenant-rls.md · relation: conceptually_related_to

## Knowledge Gaps
- **250 isolated node(s):** `$schema`, `enabled`, `clientKind`, `useIgnoreFile`, `includes` (+245 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `src/dperj.ts (cliente API DPERJ + fila retry)` and `DperjFila (entidade Prisma)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Estado atual: schema single-tenant (sem orgId)` and `Schema do Banco (Prisma) — blueprint Fase 5 (Organization/Flow/Conversation/User)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `env` connect `Assistidos & KYC API` to `LangGraph Engine Core`, `Cache & Config Engine`, `Auth & Admin API`, `WhatsApp Channel & Payloads`, `Processos PDPJ API`, `Ficha PDF Generation`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **Why does `CLAUDE.md (project context doc)` connect `CLAUDE.md Doc Index` to `Fluxo Categorizado (Legacy)`, `Deploy AWS v2 Infra`, `Cache de Reescrita & Tom`, `Bedrock KB & Guia Linguagem`, `Multi-turn Pattern & Queue`, `Guia Frontend & CI Tests`, `Casos de Uso — Ops DPERJ`, `DB Deploy (Railway/Supabase)`, `Upload Imagem`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **Why does `Documento de Requisitos (RF/RNF/RN)` connect `Máquina de Estados & Requisitos` to `OpenAPI Endpoints`, `LGPD & Segurança`, `Multi-tenant Plano`, `WhatsApp Go-Live Requirements`, `Serviços — Categorias DPERJ`, `PDPJ Processos (Staging)`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **What connects `$schema`, `enabled`, `clientKind` to the rest of the system?**
  _263 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `LangGraph Engine Core` be split into smaller, more focused modules?**
  _Cohesion score 0.07459505541346974 - nodes in this community are weakly interconnected._