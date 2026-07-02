# Infra — Terraform (arquitetura-alvo AWS)

IaC do backend Maria Chat v2 (ECS Fargate + SQS + EventBridge). Ver
`../../docs/STRUCTURE.md` e `../../docs/arquitetura-maria.drawio`.

## Estado atual (Fases 0–1)
- `network.tf` — VPC, sub-redes pública/privada (2 AZs), IGW, NAT, rotas.
- `ecr.tf` — repositórios de imagem (api, worker) + lifecycle.
- `secrets.tf` — Secrets Manager: `db` (credenciais geradas) e `app` (tokens + DATABASE_URL). Valores reais fora do TF.
- `rds.tf` — RDS PostgreSQL nesta VPC (privado, criptografado) + subnet group + SG.
- `rds_proxy.tf` — RDS Proxy + IAM (lê secret) + SG + target + output `database_url`.

## RDS — nesta VPC, com Proxy
O RDS é **dedicado a esta aplicação**, então vive na VPC nova (privado), com
**RDS Proxy** na frente (pooling p/ muitas tasks — RNF-08). A `DATABASE_URL`
(output `database_url`) aponta para o **proxy**.

> **Migração de dados:** a instância provisória de teste não é importada; migrar
> via `pg_dump`/`pg_restore` da antiga para a nova, ou simplesmente re-seed
> (`pnpm seed`), já que é base de teste. Depois, popular o segredo `app` com a
> `DATABASE_URL` do proxy:
> `terraform output -raw database_url` → `aws secretsmanager put-secret-value`.

## Fase 2 (feita)
- `sqs.tf` — fila FIFO (MessageGroupId = sessionId) + DLQ + redrive.
- `alb.tf` — ALB público, target group (health `/health`), listener HTTP (+ HTTPS se `acm_certificate_arn`).
- `iam.tf` — execution role (ECR/logs/secrets) + task role (Bedrock/Transcribe/S3/SQS/Secrets).
- `ecs.tf` — cluster, SG das tasks, task defs api/worker, serviços, autoscaling (CPU + profundidade da fila no worker).

## Fase 3 (feita)
- `eventbridge.tf` — 3 jobs agendados (retry DPERJ 5min, limpeza diária, health 6h)
  como tasks Fargate pontuais (RunTask) reusando a imagem do worker com o comando
  sobrescrito (`node dist/jobs/jobs.js <job>`). IAM p/ o EventBridge rodar ECS.

## Fase 4 (feita)
- `observability.tf` — SNS (e-mail opcional), alarmes (DLQ não-vazia, fila atrasada,
  ALB 5xx, api unhealthy) e dashboard CloudWatch (fila, CPU, ALB).
- `vpc_endpoints.tf` — S3 gateway (grátis) + interface endpoints (ECR, logs,
  secrets, sqs, bedrock, transcribe) → tira o tráfego AWS do NAT.

## CI/CD (OIDC)
- `github_oidc.tf` — provider OIDC do GitHub + role assumível pelo repo, com
  permissão de push no ECR e deploy no ECS (sem chave AWS no GitHub).
- Após `apply`: `terraform output github_actions_role_arn` → setar como variável
  de repositório **`AWS_ROLE_ARN`** (GitHub → Settings → Variables → Actions).
- Workflow: `.github/workflows/ci.yml` (PR = testes; merge na main = testes → build
  api/worker → ECR → force-deploy ECS, job `deploy` gated pelo `test`).
  `tf-check.yml` roda `fmt`+`validate` em PR que toca `infra/terraform/**`.

## Fase 5 — código (fora do Terraform)
Extrair `packages/core`/`db`, montar `services/api` e `services/worker`, criar
`dist/jobs.js` (entrypoint dos jobs), Dockerfiles e o split webhook→SQS→worker.

## Uso

```bash
# 1) Criar o backend de state (uma vez) — ver backend.tf
# 2) Init + plan + apply
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # ajustar
terraform init
terraform plan
terraform apply
```

## Notas
- **Região:** default `us-east-1`. Avaliar `sa-east-1` por residência de dados
  (LGPD — ver `docs/lgpd-seguranca.md`, [AÇÃO] transferência internacional).
- **NAT único** para conter custo; para HA, um NAT por AZ.
- **RDS:** o Postgres existente é mantido; o Terraform adiciona o RDS Proxy na
  frente. Importar o RDS atual para o state ou referenciá-lo por data source.
- Não commitar `terraform.tfvars` nem `*.tfstate` (ver `.gitignore`).
