# Infra — Terraform (arquitetura-alvo AWS)

IaC do backend Maria Chat v2 (ECS Fargate + SQS + EventBridge). Ver
`../../STRUCTURE.md` e `../../docs/arquitetura-maria.drawio`.

## Estado atual (Fase 0)
- `network.tf` — VPC, sub-redes pública/privada (2 AZs), IGW, NAT, rotas.

## Próximos módulos (a criar, por fase)
| Fase | Arquivo | Recursos |
|---|---|---|
| 1 | `ecr.tf` | repositórios de imagem (api, worker) |
| 1 | `secrets.tf` | Secrets Manager (tokens PDPJ/WA, JWT, DB) |
| 1 | `rds_proxy.tf` | RDS Proxy na frente do RDS + security groups |
| 2 | `alb.tf` | Application Load Balancer + target groups |
| 2 | `ecs.tf` | cluster ECS, task defs e serviços api/worker (autoscaling) |
| 2 | `sqs.tf` | fila FIFO (MessageGroupId = sessionId) + DLQ |
| 3 | `eventbridge.tf` | schedules (retry DPERJ, limpeza, health) |
| 4 | `observability.tf` | log groups, alarmes CloudWatch |

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
