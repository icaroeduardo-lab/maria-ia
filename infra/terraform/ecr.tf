# Fase 1 — Repositórios de imagem (uma imagem por serviço: api, worker).

locals {
  ecr_repos = toset(["api", "worker"])
}

resource "aws_ecr_repository" "this" {
  for_each             = local.ecr_repos
  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Mantém só as últimas 10 imagens (limpa as antigas).
resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Manter apenas as últimas 10 imagens"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

output "ecr_repo_urls" {
  value       = { for k, r in aws_ecr_repository.this : k => r.repository_url }
  description = "URLs dos repositórios ECR (api, worker)."
}
