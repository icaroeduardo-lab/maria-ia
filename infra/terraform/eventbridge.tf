# Fase 3 — Jobs agendados via EventBridge (substituem os setInterval do monolito).
# Cada schedule roda uma task Fargate pontual (RunTask) reutilizando a imagem do
# worker, sobrescrevendo o comando. A task executa o job e encerra.

locals {
  jobs = {
    retry-dperj = {
      schedule = "rate(5 minutes)"
      command  = ["node", "dist/jobs.js", "retry-dperj"]
      desc     = "Reenvia à DPERJ os payloads que falharam (fila)."
    }
    limpeza = {
      schedule = "cron(0 3 * * ? *)" # 03:00 UTC diário
      command  = ["node", "dist/jobs.js", "limpeza"]
      desc     = "Expira conversas inativas e dados efêmeros."
    }
    health = {
      schedule = "rate(6 hours)"
      command  = ["node", "dist/jobs.js", "health"]
      desc     = "Verifica validade do token do WhatsApp e alerta."
    }
  }
}

# ── IAM: EventBridge roda tasks ECS ───────────────────────────────────────────
data "aws_iam_policy_document" "events_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "events_ecs" {
  name               = "${local.name}-events-ecs"
  assume_role_policy = data.aws_iam_policy_document.events_assume.json
}

resource "aws_iam_role_policy_attachment" "events_ecs" {
  role       = aws_iam_role.events_ecs.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceEventsRole"
}

# passar as roles da task para o RunTask
data "aws_iam_policy_document" "events_passrole" {
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
  }
}

resource "aws_iam_role_policy" "events_passrole" {
  name   = "passrole"
  role   = aws_iam_role.events_ecs.id
  policy = data.aws_iam_policy_document.events_passrole.json
}

# ── Regras (uma por job) ──────────────────────────────────────────────────────
resource "aws_cloudwatch_event_rule" "job" {
  for_each            = local.jobs
  name                = "${local.name}-job-${each.key}"
  description         = each.value.desc
  schedule_expression = each.value.schedule
}

resource "aws_cloudwatch_event_target" "job" {
  for_each = local.jobs
  rule     = aws_cloudwatch_event_rule.job[each.key].name
  arn      = aws_ecs_cluster.main.arn
  role_arn = aws_iam_role.events_ecs.arn

  ecs_target {
    task_definition_arn = aws_ecs_task_definition.worker.arn
    task_count          = 1
    launch_type         = "FARGATE"
    platform_version    = "LATEST"

    network_configuration {
      subnets          = aws_subnet.private[*].id
      security_groups  = [aws_security_group.tasks.id]
      assign_public_ip = false
    }
  }

  # sobrescreve o comando do container para rodar o job específico
  input = jsonencode({
    containerOverrides = [{
      name    = "worker"
      command = each.value.command
    }]
  })
}
