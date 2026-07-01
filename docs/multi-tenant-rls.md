# Multi-tenant / RLS — estado e plano

## Estado atual: single-tenant
O schema (`prisma/schema.prisma`) é **single-tenant** — atende só a DPERJ.
Nenhum model tem `orgId`/`organizationId` e não há model `Organization`:
`Flow`, `Conversation`, `User`, `AuditLog`, `Config`, `Assistido`, `Caso`.

Logo, **RLS para isolamento multi-tenant não se aplica hoje** — não existe a
dimensão de organização para isolar. (O `thread_id` do LangGraph é o `sessionId`,
ex. `wa:<numero>`, sem prefixo de org.)

> Obs.: o CLAUDE.md descreve uma "Fase 6" multi-tenant, mas ela **não está
> refletida neste schema/deploy**. Tratar como roadmap, não como implementado.

## Para virar multi-tenant (quando necessário)
1. **Modelo**: criar `Organization` e adicionar `orgId` (FK) em `Flow`,
   `Conversation`, `User`, `AuditLog`, `Config`, `Assistido`, `Caso` + índices.
2. **App**: resolver a org por subdomínio/header (web) e por `phone_number_id`
   (WhatsApp); escopar TODA query por `orgId`; `thread_id = <orgId>:<sessionId>`.
3. **RLS (defesa em profundidade)**, depois do passo 2:
   - Usar um role de aplicação sem `BYPASSRLS`.
   - Em cada model: `ALTER TABLE "X" ENABLE ROW LEVEL SECURITY;`
     `CREATE POLICY org_isolation ON "X" USING ("orgId" = current_setting('app.current_org', true));`
   - No app, **por transação/requisição**: `SELECT set_config('app.current_org', $orgId, true)`
     antes das queries (Prisma: `$transaction` com `$executeRaw` do `set_config`).
   - Cuidar do pooling: o GUC precisa estar na mesma conexão/transação das queries.

## Recomendação
Implementar RLS **só junto** com a virada multi-tenant real (passos 1–2). Fazer
RLS antes disso não agrega (não há o que isolar) e adiciona risco de quebrar
queries por GUC ausente. Por isso **não** foi aplicado agora.
