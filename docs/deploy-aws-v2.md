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
    WA_PHONE_NUMBER_ID: "<phone number id>",
    WA_WEBHOOK_VERIFY_TOKEN: "<verify token do webhook>",
    PDPJ_API_TOKEN: "<token PDPJ staging>",
    PDPJ_API_URL: "https://api-processo.stg.data-lake.pdpj.jus.br/processo-api/api/v1",
    DPERJ_API_URL: "",
    DPERJ_API_KEY: ""
  }')"
```

> **Já resolvidos no Terraform** (não precisa configurar): `SELF_URL` (api = localhost,
> worker = ALB), `BEDROCK_MODEL_ID`/`BEDROCK_KB_ID`/`BEDROCK_KB_DS_ID`, `AWS_REGION`,
> `S3_BUCKET`, `SQS_QUEUE_URL`, `PORT`.

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

0. Workflow em `.github/workflows/ci.yml`: testes em PR e **deploy no merge para
   main** (test → build → ECR → force-deploy ECS). `tf-check.yml` valida a infra em PR.
1. GitHub → repo → Settings → Variables → Actions → criar **`AWS_ROLE_ARN`** =
   `terraform output github_actions_role_arn`.
2. Merge na main dispara o deploy automaticamente (job `deploy`, gated pelo `test`).
   Ele builda `api`/`worker`, publica no ECR e força novo deployment.
3. As tasks ECS puxam as imagens e estabilizam.

## 6. HTTPS + webhook do WhatsApp

A Meta exige **webhook HTTPS com certificado válido** — o ALB só com HTTP:80 não
serve. Com o domínio numa hosted zone do **Route53**, o Terraform emite/valida o
certificado (ACM) e aponta o domínio para o ALB automaticamente:

1. `terraform apply` com:
   ```
   -var 'domain_name=maria.dperj.rj.gov.br' -var 'route53_zone_name=dperj.rj.gov.br'
   ```
   Cria: certificado ACM (validação DNS), registros de validação, listener 443 e
   o alias A do domínio → ALB. Saída: `app_url = https://<dominio>`.
2. `PUBLIC_URL` = `app_url` (secret `app`) → links do KYC ficam no domínio, sem túnel.
3. No app da Meta: webhook = `https://<dominio>/webhook/whatsapp`,
   verify token = `WA_WEBHOOK_VERIFY_TOKEN`.

> Se o DNS **não** estiver no Route53: valide o certificado no ACM manualmente e
> passe `-var acm_certificate_arn=<arn>` (o listener 443 usa esse ARN).

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
