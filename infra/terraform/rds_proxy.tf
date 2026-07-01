# Fase 1 — RDS Proxy: pooling de conexões na frente do RDS (mesma VPC).
# Muitas tasks Fargate abrindo conexões diretas esgotam o RDS; o proxy resolve.

# SG do proxy: aceita 5432 das tasks (refinar para o SG app na Fase 2).
resource "aws_security_group" "rds_proxy" {
  name        = "${local.name}-rds-proxy"
  description = "RDS Proxy — aceita conexões das tasks Fargate"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "PostgreSQL das tasks (VPC)"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr] # refinar para o SG app na Fase 2
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-rds-proxy" }
}

# IAM: o proxy lê as credenciais do banco no Secrets Manager.
data "aws_iam_policy_document" "proxy_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "proxy" {
  name               = "${local.name}-rds-proxy"
  assume_role_policy = data.aws_iam_policy_document.proxy_assume.json
}

data "aws_iam_policy_document" "proxy_secret" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.db.arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "proxy_secret" {
  name   = "read-db-secret"
  role   = aws_iam_role.proxy.id
  policy = data.aws_iam_policy_document.proxy_secret.json
}

resource "aws_db_proxy" "main" {
  name                   = "${local.name}-proxy"
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy.arn
  vpc_subnet_ids         = aws_subnet.private[*].id
  vpc_security_group_ids = [aws_security_group.rds_proxy.id]
  require_tls            = true
  idle_client_timeout    = 1800

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_secretsmanager_secret.db.arn
  }

  depends_on = [aws_secretsmanager_secret_version.db]
}

resource "aws_db_proxy_default_target_group" "main" {
  db_proxy_name = aws_db_proxy.main.name

  connection_pool_config {
    max_connections_percent      = 90
    max_idle_connections_percent = 50
    connection_borrow_timeout    = 120
  }
}

resource "aws_db_proxy_target" "main" {
  db_proxy_name          = aws_db_proxy.main.name
  target_group_name      = aws_db_proxy_default_target_group.main.name
  db_instance_identifier = aws_db_instance.main.identifier
}

output "rds_proxy_endpoint" {
  value       = aws_db_proxy.main.endpoint
  description = "Endpoint do RDS Proxy (usar no DATABASE_URL das tasks)."
}

# DATABASE_URL pronta (aponta para o proxy) — usar para popular o segredo da app.
output "database_url" {
  value       = "postgresql://${var.db_username}:${random_password.db.result}@${aws_db_proxy.main.endpoint}:5432/${var.db_name}?sslmode=require"
  description = "String de conexão via RDS Proxy."
  sensitive   = true
}
