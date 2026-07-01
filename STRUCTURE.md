# Maria Chat v2 — Estrutura da aplicação (arquitetura-alvo AWS)

> Branch `arch/aws-fargate-v2`. Reorganiza o projeto para a arquitetura-alvo
> (ECS Fargate + SQS + EventBridge), separando entrada (api) do processamento
> (worker) e extraindo o núcleo compartilhado. Ver `docs/arquitetura-maria.drawio`.

## Layout do monorepo (alvo)

```
maria-chat/
├── infra/
│   └── terraform/          # IaC (rede, ECR, ECS, ALB, SQS, RDS Proxy, Secrets, EventBridge)
├── services/
│   ├── api/                # Fastify: webhook WhatsApp (200 + enfileira) + /admin + /api/chat + /health
│   └── worker/             # consumidor SQS: roda o engine LangGraph e responde
├── packages/
│   ├── core/               # engine compartilhado: graph builder, nodes, state, integrações
│   │                       #   (Bedrock, PDPJ, DPERJ, Transcribe, ficha, mask, resumo)
│   └── db/                 # Prisma schema + client gerado
├── frontend/               # painel admin (inalterado)
└── docs/                   # modelagem (requisitos, arquitetura, UML, LGPD, openapi...)
```

O código atual em `src/` migra assim:
- `src/engine/*`, `src/nodes/*`, `src/services/*`, `src/state.ts`, `src/perguntas.ts`,
  `src/processos.ts`, `src/dperj.ts`, `src/mask.ts`, `src/resumo.ts`, `src/config.ts`,
  `src/transcribe.ts` → **packages/core**
- `src/db.ts`, `prisma/*` → **packages/db**
- `src/server.ts`, `src/routes/*`, `src/channels/whatsapp.ts` (webhook) → **services/api**
- `src/chat.ts` + consumidor novo → **services/worker**

## Plano de implementação (fases)

**Fase 0 — Infra base (aqui):** rede (VPC/subnets/NAT). Passo 1.
**Fase 1 — Plataforma:** ECR, Secrets Manager, RDS Proxy (na frente do RDS), IAM.
**Fase 2 — Compute:** cluster ECS, ALB, serviço `api`, SQS FIFO, serviço `worker`.
**Fase 3 — Jobs:** EventBridge Scheduler (retry DPERJ, limpeza, health do token).
**Fase 4 — Observabilidade:** CloudWatch (logs/alarmes) + dashboards.
**Fase 5 — Código:** extrair `packages/core`/`db`, montar `api` e `worker`, split
  webhook→SQS→worker. Reaproveita o engine atual quase inteiro.
**Fase 6 — Cutover:** load test (~1.5M msg/mês) e virada.

## Decisões (resumo)
- **Terraform** (não CloudFormation): módulos, `plan`, ecossistema. State remoto S3+lock.
- **SQS FIFO** com `MessageGroupId = sessionId` → ordem por conversa, sem concorrência.
- **RDS existente reutilizado** (não criado pelo TF); conexão direta via secret.
  RDS Proxy fica pendente (exige o RDS na mesma VPC — ver `infra/terraform/README.md`).
- **api** escala por CPU/req; **worker** por profundidade da fila.
