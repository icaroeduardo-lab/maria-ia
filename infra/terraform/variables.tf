variable "project" {
  type        = string
  default     = "maria-chat"
  description = "Nome do projeto (tag e prefixo de recursos)."
}

variable "environment" {
  type        = string
  default     = "prod"
  description = "Ambiente (prod | staging)."
}

variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "Região AWS. Avaliar sa-east-1 por residência de dados (LGPD)."
}

variable "vpc_cidr" {
  type        = string
  default     = "10.20.0.0/16"
  description = "CIDR da VPC."
}

variable "azs" {
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
  description = "Zonas de disponibilidade (mínimo 2)."
}

variable "public_subnet_cidrs" {
  type        = list(string)
  default     = ["10.20.0.0/24", "10.20.1.0/24"]
  description = "CIDRs das sub-redes públicas (ALB, NAT)."
}

variable "private_subnet_cidrs" {
  type        = list(string)
  default     = ["10.20.10.0/24", "10.20.11.0/24"]
  description = "CIDRs das sub-redes privadas (Fargate, RDS, RDS Proxy)."
}

# ── Banco (RDS nesta VPC — dedicado a esta aplicação) ─────────────────────────
variable "db_name" {
  type        = string
  default     = "mariachat"
  description = "Nome do banco."
}

variable "db_username" {
  type        = string
  default     = "maria"
  description = "Usuário master do RDS."
}

variable "db_instance_class" {
  type        = string
  default     = "db.t3.small"
  description = "Classe da instância RDS."
}

variable "db_engine_version" {
  type        = string
  default     = "16"
  description = "Versão do PostgreSQL."
}

variable "db_allocated_storage" {
  type        = number
  default     = 20
  description = "Armazenamento inicial (GB)."
}
