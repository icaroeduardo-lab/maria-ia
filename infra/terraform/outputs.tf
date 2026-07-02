output "vpc_id" {
  value       = aws_vpc.main.id
  description = "ID da VPC."
}

output "public_subnet_ids" {
  value       = aws_subnet.public[*].id
  description = "IDs das sub-redes públicas (ALB/NAT)."
}

output "private_subnet_ids" {
  value       = aws_subnet.private[*].id
  description = "IDs das sub-redes privadas (Fargate/RDS Proxy)."
}
