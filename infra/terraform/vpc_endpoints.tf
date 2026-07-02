# Fase 4 — VPC Endpoints: tráfego para serviços AWS fica no backbone (não passa
# no NAT → corta custo de dados). Só o externo real (Meta/PDPJ/DPERJ) usa o NAT.

# ── Gateway endpoint: S3 (grátis) ─────────────────────────────────────────────
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  tags              = { Name = "${local.name}-vpce-s3" }
}

# ── SG dos interface endpoints (443 das tasks) ────────────────────────────────
resource "aws_security_group" "vpce" {
  name        = "${local.name}-vpce"
  description = "Interface endpoints - 443 das tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "HTTPS das tasks"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }

  tags = { Name = "${local.name}-vpce" }
}

# ── Interface endpoints: serviços chamados pelas tasks ────────────────────────
locals {
  interface_endpoints = toset([
    "ecr.api",
    "ecr.dkr",
    "logs",
    "secretsmanager",
    "sqs",
    "bedrock-runtime",
    "bedrock-agent-runtime",
    "transcribe",
  ])
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = local.interface_endpoints
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpce.id]
  private_dns_enabled = true
  tags                = { Name = "${local.name}-vpce-${each.key}" }
}
