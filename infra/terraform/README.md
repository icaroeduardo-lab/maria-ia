# Infra — Terraform (arquitetura-alvo AWS)

IaC do backend Maria Chat v2 (ECS Fargate + SQS + EventBridge). Ver
`../../STRUCTURE.md` e `../../docs/arquitetura-maria.drawio`.

## Estado atual (Fases 0–1)
- `network.tf` — VPC, sub-redes pública/privada (2 AZs), IGW, NAT, rotas.
- `ecr.tf` — repositórios de imagem (api, worker) + lifecycle.
- `secrets.tf` — Secrets Manager: `db` (DATABASE_URL do RDS existente) e `app` (tokens). Valores reais fora do TF.

## RDS — reutilizado (não criado pelo TF)
O RDS PostgreSQL **existente** é reaproveitado. As tasks conectam direto via a
`DATABASE_URL` no segredo `db` (preenchida fora do TF). O Terraform **não**
cria/gerencia a instância.

> **RDS Proxy pendente:** o proxy exige o banco na MESMA VPC. O RDS atual está
> fora desta VPC (público). Para habilitar pooling depois: trazer o RDS para
> esta VPC (migração dump/restore) ou fazer VPC peering, e então adicionar
> `rds_proxy.tf`. Enquanto isso, conexão direta (atenção ao limite de conexões
> sob muitas tasks — RNF-08).

## Próximos módulos (a criar, por fase)
| Fase | Arquivo | Recursos |
|---|---|---|
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
