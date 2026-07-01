# Fase 1 — Secrets Manager.
# Dois segredos (valores reais preenchidos FORA do Terraform — CI ou console;
# o TF só cria o segredo e uma versão placeholder com ignore_changes):
#  - db  : DATABASE_URL do RDS EXISTENTE (reutilizado, não criado pelo TF)
#  - app : tokens da aplicação (PDPJ, WhatsApp, JWT, Stripe...)

# ── Conexão do banco (RDS existente reutilizado) ─────────────────────────────
resource "aws_secretsmanager_secret" "db" {
  name        = "${local.name}/db"
  description = "DATABASE_URL do RDS PostgreSQL existente (reutilizado)."
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    # Preencher com a URL do RDS existente (fora do TF):
    #   aws secretsmanager put-secret-value --secret-id maria-chat-prod/db \
    #     --secret-string '{"DATABASE_URL":"postgresql://user:pass@host:5432/mariachat?sslmode=require"}'
    DATABASE_URL = "PREENCHER"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ── Segredos da aplicação (valores reais setados fora do TF) ──────────────────
resource "aws_secretsmanager_secret" "app" {
  name        = "${local.name}/app"
  description = "Tokens/segredos da aplicação (PDPJ, WhatsApp, JWT...)."
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    JWT_SECRET      = "PREENCHER"
    WA_ACCESS_TOKEN = "PREENCHER"
    PDPJ_API_TOKEN  = "PREENCHER"
    PDPJ_API_URL    = "https://api-processo.stg.data-lake.pdpj.jus.br/processo-api/api/v1"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

output "secret_db_arn" {
  value       = aws_secretsmanager_secret.db.arn
  description = "ARN do segredo com a DATABASE_URL do RDS existente."
}

output "secret_app_arn" {
  value       = aws_secretsmanager_secret.app.arn
  description = "ARN do segredo da aplicação."
}
