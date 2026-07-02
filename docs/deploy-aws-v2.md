# Maria Chat v2 — Deploy na AWS (passo a passo do primeiro apply)

> Arquitetura-alvo: ECS Fargate + SQS + EventBridge (branch `arch/aws-fargate-v2`).
> Ver `infra/terraform/`, `STRUCTURE.md` e `docs/arquitetura-maria.drawio`.

## Pré-requisitos
- AWS CLI autenticado (perfil com permissão de admin para criar a infra).
- Terraform ≥ 1.6, Docker, `psql`/`pg_dump` (para migrar dados).
- Região: `us-east-1` (avaliar `sa-east-1` — LGPD, ver `docs/lgpd-seguranca.md`).

---

## 1. Backend de state (uma vez)

```bash
aws s3api create-bucket --bucket maria-tfstate --region us-east-1
aws s3api put-bucket-versioning --bucket maria-tfstate \
  --versioning-configuration Status=Enabled
aws dynamodb create-table --table-name maria-tf-lock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST
```

## 2. Provisionar a infra

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # ajustar se quiser
terraform init
terraform plan
terraform apply
```

Cria: VPC/subnets/NAT, ECR (api, worker), Secrets Manager, RDS + RDS Proxy,
SQS FIFO + DLQ, ALB, ECS (cluster + serviços api/worker + autoscaling),
EventBridge (jobs), observabilidade, VPC endpoints e a role OIDC do GitHub.

> Na primeira vez os serviços ECS sobem **sem imagem** no ECR → as tasks falham
> ao puxar e ficam reiniciando. Normal: assim que o CI publicar as imagens
> (passo 5) elas estabilizam.

### Outputs úteis
```bash
terraform output                      # visão geral
terraform output -raw database_url    # DATABASE_URL via proxy (sensível)
terraform output github_actions_role_arn
terraform output alb_dns_name
```

## 3. Preencher os segredos

O Terraform cria os segredos com placeholders. Preencher os valores reais:

```bash
# DATABASE_URL (aponta para o RDS Proxy) + tokens
DB_URL=$(terraform output -raw database_url)
aws secretsmanager put-secret-value --secret-id maria-chat-prod/app \
  --secret-string "$(jq -n --arg db "$DB_URL" '{
    DATABASE_URL: $db,
    JWT_SECRET: "<gerar>",
    WA_ACCESS_TOKEN: "<token WhatsApp>",
    PDPJ_API_TOKEN: "<token PDPJ staging>",
    PDPJ_API_URL: "https://api-processo.stg.data-lake.pdpj.jus.br/processo-api/api/v1"
  }')"
```

## 4. Migrar / semear o banco

O RDS é privado (só acessível pelo proxy, dentro da VPC). Opções:

- **Migração:** a task da **api** roda `prisma migrate deploy` no start — cria o
  schema automaticamente.
- **Dados:** migrar do RDS de teste (`pg_dump | pg_restore`) **ou** rodar o seed
  como task pontual:
  ```bash
  # seed via task ECS (imagem worker, comando sobrescrito)
  aws ecs run-task --cluster maria-chat-prod \
    --launch-type FARGATE --task-definition maria-chat-prod-worker \
    --network-configuration '{"awsvpcConfiguration":{"subnets":["<priv1>","<priv2>"],"securityGroups":["<tasks-sg>"],"assignPublicIp":"DISABLED"}}' \
    --overrides '{"containerOverrides":[{"name":"worker","command":["pnpm","seed"]}]}'
  ```

## 5. Primeiro deploy das imagens (CI)

0. **Ativar o workflow:** copiar `infra/ci/deploy.yml` → `.github/workflows/deploy.yml`
   (o push desse caminho exige token com escopo `workflow` — pela UI do GitHub ou
   `gh auth refresh -s workflow`).
1. GitHub → repo → Settings → Variables → Actions → criar **`AWS_ROLE_ARN`** =
   `terraform output github_actions_role_arn`.
2. Rodar o workflow **deploy** (push nas paths monitoradas ou `workflow_dispatch`).
   Ele builda `api`/`worker`, publica no ECR e força novo deployment.
3. As tasks ECS puxam as imagens e estabilizam.

## 6. HTTPS + webhook do WhatsApp

A Meta exige **webhook HTTPS com certificado válido** — o ALB só com HTTP:80 não
serve. Providenciar domínio + certificado:

1. Emitir certificado no **ACM** para o domínio (ex: `maria.dperj...`).
2. `terraform apply` com `-var acm_certificate_arn=<arn>` → cria o listener 443.
3. Apontar o DNS do domínio (CNAME/alias) para o `alb_dns_name`.
4. No app da Meta: webhook = `https://<dominio>/webhook/whatsapp`,
   verify token = `WA_WEBHOOK_VERIFY_TOKEN` (adicionar ao segredo/app).

## 7. Verificar

```bash
curl https://<dominio>/health        # { ok, db, whatsappToken }
```
Mandar um "oi" no WhatsApp e acompanhar os logs (CloudWatch `/ecs/maria-chat-prod/*`).

---

## Ordem de dependência (resumo)
state → apply → segredos → (migrate automático) → AWS_ROLE_ARN → CI (imagens) →
ACM/domínio → webhook Meta → teste.

## Teardown
```bash
cd infra/terraform && terraform destroy
# apagar depois o RDS de teste antigo:
aws cloudformation delete-stack --stack-name maria-rds-test
```
> `deletion_protection = true` no RDS: remover no `rds.tf` (ou via console) antes
> do destroy. Segredos têm janela de recuperação padrão (7–30 dias).
