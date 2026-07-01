# Fase 1 — Secrets Manager.
# Dois segredos:
#  - db  : credenciais do RDS (usadas pelo RDS Proxy e pelas tasks)
#  - app : tokens da aplicação (PDPJ, WhatsApp, JWT, Stripe...) — valores reais
#          preenchidos FORA do Terraform (CI ou console); o TF só cria o segredo.

# ── Senha do banco (gerada e guardada no secret) ─────────────────────────────
resource "random_password" "db" {
  length  = 32
  special = false # evita chars que quebram URL de conexão
}

resource "aws_secretsmanager_secret" "db" {
  name        = "${local.name}/db"
  description = "Credenciais do RDS PostgreSQL do Maria Chat."
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = var.db_username
    password = random_password.db.result
    engine   = "postgres"
    host     = aws_db_instance.main.address
    port     = 5432
    dbname   = var.db_name
  })
}

# ── Segredos da aplicação (valores reais setados fora do TF) ──────────────────
resource "aws_secretsmanager_secret" "app" {
  name        = "${local.name}/app"
  description = "Tokens/segredos da aplicação (PDPJ, WhatsApp, JWT...)."
}

# Cria uma versão placeholder só para o segredo existir; o valor real é
# gerenciado por fora (aws secretsmanager put-secret-value / CI). ignore_changes
# impede o TF de sobrescrever o valor real depois.
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
  description = "ARN do segredo de credenciais do banco."
}

output "secret_app_arn" {
  value       = aws_secretsmanager_secret.app.arn
  description = "ARN do segredo da aplicação."
}
