# ElastiCache Redis — cache das reescritas de pergunta (chave
# flowId:nodeId:tom:styleVersion). Compartilhado entre as tasks api/worker.
# Fica na VPC privada; só o SG das tasks acessa. Cache regenerável → sem HA
# (single node) para conter custo; subir num_cache_clusters p/ réplica se quiser.

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name}-cache"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "ElastiCache Redis - aceita 6379 das tasks Fargate"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Redis das tasks"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-redis" }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = "${local.name}-cache"
  description                = "Cache de reescrita (Maria Chat)"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.elasticache_node_type
  num_cache_clusters         = 1
  automatic_failover_enabled = false
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
}

output "redis_endpoint" {
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
  description = "Endpoint do Redis (usar em REDIS_URL das tasks)."
}
