# Fase 1 — Secrets Manager.
#  - db  : credenciais do RDS (usadas pelo RDS Proxy — auth SECRETS)
#  - app : tokens da aplicação (PDPJ, WhatsApp, JWT...) — valores reais fora do TF.

# ── Senha do banco (gerada e guardada no secret) ─────────────────────────────
resource "random_password" "db" {
  length  = 32
  special = false # evita chars que quebram URL de conexão
}

resource "aws_secretsmanager_secret" "db" {
  name        = "${local.name}/db"
  description = "Credenciais do RDS PostgreSQL (auth do RDS Proxy)."
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
# Preencher DATABASE_URL com o output `database_url` (aponta para o RDS Proxy):
#   terraform output -raw database_url | ...  → put-secret-value
resource "aws_secretsmanager_secret" "app" {
  name        = "${local.name}/app"
  description = "Tokens/segredos da aplicação (PDPJ, WhatsApp, JWT, DATABASE_URL...)."
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    DATABASE_URL            = "PREENCHER" # usar output database_url (via proxy)
    JWT_SECRET              = "PREENCHER"
    WA_ACCESS_TOKEN         = "PREENCHER"
    WA_PHONE_NUMBER_ID      = "PREENCHER"
    WA_WEBHOOK_VERIFY_TOKEN = "PREENCHER"
    PDPJ_API_TOKEN          = "PREENCHER"
    PDPJ_API_URL            = "https://api-processo.stg.data-lake.pdpj.jus.br/processo-api/api/v1"
    DPERJ_API_URL           = "" # vazio = modo mock (protocolo local)
    DPERJ_API_KEY           = ""
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
