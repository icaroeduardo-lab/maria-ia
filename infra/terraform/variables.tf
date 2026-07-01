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

# ── Compute (ECS Fargate) ─────────────────────────────────────────────────────
variable "container_port" {
  type        = number
  default     = 3000
  description = "Porta do container da api (Fastify)."
}

variable "api_image_tag" {
  type        = string
  default     = "latest"
  description = "Tag da imagem do serviço api no ECR."
}

variable "worker_image_tag" {
  type        = string
  default     = "latest"
  description = "Tag da imagem do serviço worker no ECR."
}

variable "api_cpu" {
  type        = number
  default     = 512
  description = "CPU da task api (unidades)."
}

variable "api_memory" {
  type        = number
  default     = 1024
  description = "Memória da task api (MiB)."
}

variable "worker_cpu" {
  type        = number
  default     = 512
  description = "CPU da task worker (unidades)."
}

variable "worker_memory" {
  type        = number
  default     = 1024
  description = "Memória da task worker (MiB)."
}

variable "api_min" {
  type    = number
  default = 2
}

variable "api_max" {
  type    = number
  default = 10
}

variable "worker_min" {
  type    = number
  default = 2
}

variable "worker_max" {
  type    = number
  default = 20
}

variable "worker_msgs_per_task" {
  type        = number
  default     = 100
  description = "Mensagens visíveis na fila por task antes de escalar o worker."
}

variable "acm_certificate_arn" {
  type        = string
  default     = ""
  description = "ARN do certificado ACM para HTTPS no ALB. Vazio = só HTTP:80."
}

variable "s3_bucket" {
  type        = string
  default     = "maria-ia"
  description = "Bucket S3 de fichas/áudios (efêmeros)."
}

variable "alarm_email" {
  type        = string
  default     = ""
  description = "E-mail para receber alarmes (SNS). Vazio = sem inscrição."
}
