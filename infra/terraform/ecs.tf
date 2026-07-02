# Fase 2 — ECS Fargate: cluster, serviços api (atrás do ALB) e worker
# (consome SQS), com autoscaling. Tasks em sub-rede privada.

# ── SG das tasks ──────────────────────────────────────────────────────────────
resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "Tasks Fargate — inbound só do ALB (api); egress liberado"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "App port do ALB"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-tasks" }
}

# ── Cluster + logs ────────────────────────────────────────────────────────────
resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}/api"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name}/worker"
  retention_in_days = 30
}

# ── Secrets injetados como env (chaves do segredo app) ────────────────────────
locals {
  app_secret_keys = [
    "DATABASE_URL", "JWT_SECRET",
    "WA_ACCESS_TOKEN", "WA_PHONE_NUMBER_ID", "WA_WEBHOOK_VERIFY_TOKEN",
    "PDPJ_API_TOKEN", "PDPJ_API_URL", "DPERJ_API_URL", "DPERJ_API_KEY",
  ]
  app_secret_env = [
    for k in local.app_secret_keys :
    { name = k, valueFrom = "${aws_secretsmanager_secret.app.arn}:${k}::" }
  ]
  common_env = [
    { name = "AWS_REGION", value = var.aws_region },
    { name = "S3_BUCKET", value = var.s3_bucket },
    { name = "SQS_QUEUE_URL", value = aws_sqs_queue.msgs.url },
    { name = "BEDROCK_MODEL_ID", value = var.bedrock_model_id },
    { name = "BEDROCK_KB_ID", value = var.bedrock_kb_id },
    { name = "BEDROCK_KB_DS_ID", value = var.bedrock_kb_ds_id },
  ]
}

# ── Task definition: api ──────────────────────────────────────────────────────
resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name         = "api"
    image        = "${aws_ecr_repository.this["api"].repository_url}:${var.api_image_tag}"
    essential    = true
    portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]
    environment = concat(local.common_env, [
      { name = "PORT", value = tostring(var.container_port) },
      # api serve as rotas /api/* localmente → chamadas internas do grafo em localhost
      { name = "SELF_URL", value = "http://localhost:${var.container_port}" },
    ])
    secrets = local.app_secret_env
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

# ── Task definition: worker ───────────────────────────────────────────────────
resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "worker"
    image     = "${aws_ecr_repository.this["worker"].repository_url}:${var.worker_image_tag}"
    essential = true
    # o grafo no worker chama /api/ficha, /api/kyc etc. → resolve no serviço api via ALB
    environment = concat(local.common_env, [
      { name = "SELF_URL", value = "http://${aws_lb.main.dns_name}" },
    ])
    secrets = local.app_secret_env
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.worker.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "worker"
      }
    }
  }])
}

# ── Serviço api (atrás do ALB) ────────────────────────────────────────────────
resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_min
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = var.container_port
  }

  depends_on = [aws_lb_listener.http]

  lifecycle {
    ignore_changes = [desired_count] # gerenciado pelo autoscaling
  }
}

# ── Serviço worker (consome SQS) ──────────────────────────────────────────────
resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_min
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}

# ── Autoscaling: api por CPU ──────────────────────────────────────────────────
resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_min
  max_capacity       = var.api_max
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 60
  }
}

# ── Autoscaling: worker por CPU + profundidade da fila ────────────────────────
resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.worker_min
  max_capacity       = var.worker_max
}

resource "aws_appautoscaling_policy" "worker_cpu" {
  name               = "${local.name}-worker-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 60
  }
}

# escala o worker quando a fila acumula (step scaling por alarme)
resource "aws_appautoscaling_policy" "worker_sqs" {
  name               = "${local.name}-worker-sqs"
  policy_type        = "StepScaling"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 60
    metric_aggregation_type = "Average"
    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment          = 2
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_backlog" {
  alarm_name          = "${local.name}-worker-backlog"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.msgs.name }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.worker_msgs_per_task * var.worker_min
  alarm_actions       = [aws_appautoscaling_policy.worker_sqs.arn]
}
