# CI/CD — OIDC do GitHub Actions: push no ECR e deploy no ECS SEM guardar chave
# AWS no GitHub. O workflow assume esta role via token OIDC do próprio GitHub.

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

data "aws_iam_policy_document" "gha_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:*"]
    }
  }
}

resource "aws_iam_role" "gha" {
  name               = "${local.name}-gha"
  assume_role_policy = data.aws_iam_policy_document.gha_assume.json
}

data "aws_iam_policy_document" "gha" {
  # login e push no ECR
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
      "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
    ]
    resources = [for r in aws_ecr_repository.this : r.arn]
  }
  # deploy no ECS (força novo deployment; registra task def se necessário)
  statement {
    actions = [
      "ecs:UpdateService", "ecs:DescribeServices",
      "ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition",
    ]
    resources = ["*"]
  }
  # passar as roles das tasks ao registrar/atualizar
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
  }
}

resource "aws_iam_role_policy" "gha" {
  name   = "cicd"
  role   = aws_iam_role.gha.id
  policy = data.aws_iam_policy_document.gha.json
}

output "github_actions_role_arn" {
  value       = aws_iam_role.gha.arn
  description = "Setar como variável AWS_ROLE_ARN no GitHub (repo → Settings → Variables)."
}
