# Fase 1 — RDS PostgreSQL nesta VPC (dedicado a esta aplicação).
# Como o RDS é usado só por este app, ele passa a viver na VPC nova, o que
# permite o RDS Proxy (rds_proxy.tf). Migrar os dados do RDS de teste via
# dump/restore, ou re-seed (é base de teste).

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "${local.name}-db-subnets" }
}

# SG do banco: aceita 5432 apenas do RDS Proxy.
resource "aws_security_group" "rds" {
  name        = "${local.name}-rds"
  description = "RDS — acesso só via RDS Proxy"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL do RDS Proxy"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.rds_proxy.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-rds" }
}

resource "aws_db_instance" "main" {
  identifier     = "${local.name}-pg"
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true # criptografia em repouso (LGPD)

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = false # true para HA em produção crítica

  backup_retention_period   = 7
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-pg-final"

  tags = { Name = "${local.name}-pg" }
}

output "rds_endpoint" {
  value       = aws_db_instance.main.address
  description = "Endpoint do RDS (acesso via proxy)."
}
