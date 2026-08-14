# Lambda de extração de TEXTO BRUTO (qualquer documento, não só doc de
# identidade) via AWS Textract `DetectDocumentText` — dispara
# AUTOMATICAMENTE quando um documento novo é enviado ao bucket privado de
# documentos do assistido (aws_s3_bucket.documentos, s3-documentos.tf),
# prefixo `documentos/`, extensão .jpg/.jpeg/.png/.pdf. Aplica regex/
# heurística por cima do texto pra achar CPF/nome/data de nascimento e
# grava o resultado em JSON no MESMO bucket, prefixo `extraidos-textract/`
# — só extração por enquanto, sem persistir em banco/Prisma (decisão do
# card que criou esta lambda; ver src/lambdas/ocr-documento-textract/handler.ts).
#
# Pivô de abordagem: a primeira versão usava `AnalyzeID` (API do Textract
# dedicada a doc de identidade), mas um teste ao vivo real (issue #194,
# 2026-08-13, documentado em src/core/ocr-documento-textract.ts) mostrou o
# AnalyzeID confundindo a sigla do órgão emissor com sobrenome numa CNH
# brasileira, e não achando CPF (`AnalyzeID` cobre oficialmente só
# passaporte/driver-license americano). O usuário corrigiu a direção: sem
# ficar preso a nenhuma API/tipo de documento específico. `DetectDocumentText`
# é genérico (texto puro, qualquer documento); o resultado gravado sempre
# inclui um campo `aviso` com o nível de confiança de cada campo extraído
# por regex. O pipeline principal de verificação de documento
# (src/core/ocr-documento.ts, via Bedrock multimodal) continua sendo o
# único usado pelas rotas em src/api/routes/documentos.ts; esta lambda é um
# caminho paralelo, independente, não substitui nem é chamada por ele.
#
# BUILD ANTES de `terraform plan`/`apply` (não é automático — mesmo espírito
# de "CI builda/publica a imagem, Terraform só aponta pra ela" já usado pro
# ECR em ecr.tf/ci.yml, só que aqui o artefato é um zip local, sem push):
#   pnpm --dir ../.. run build:lambda:ocr-textract
# (empacota src/lambdas/ocr-documento-textract/handler.ts com esbuild em
# dist-lambda/ocr-documento-textract/index.js — self-contained, sem
# depender de node_modules em runtime)

data "archive_file" "ocr_textract" {
  type        = "zip"
  source_dir  = "${path.module}/../../dist-lambda/ocr-documento-textract"
  output_path = "${path.module}/../../dist-lambda/ocr-documento-textract.zip"
}

resource "aws_cloudwatch_log_group" "ocr_textract" {
  name              = "/aws/lambda/${local.name}-ocr-textract"
  retention_in_days = 30
}

# ── IAM (role dedicada — mínima, separada da role das tasks ECS) ─────────────

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ocr_textract" {
  name               = "${local.name}-ocr-textract"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "ocr_textract" {
  # DetectDocumentText (síncrono, imagem) + Start/GetDocumentTextDetection
  # (assíncrono, PDF — StartDocumentTextDetection lê o objeto S3 direto por
  # DocumentLocation.S3Object, por isso a permissão s3:GetObject abaixo
  # também cobre a chamada da AWS, não só o download que a lambda faz).
  statement {
    actions = [
      "textract:DetectDocumentText",
      "textract:StartDocumentTextDetection",
      "textract:GetDocumentTextDetection",
    ]
    resources = ["*"] # Textract não suporta resource-level permission
  }
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.documentos.arn}/documentos/*"]
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.documentos.arn}/extraidos-textract/*"]
  }
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.ocr_textract.arn}:*"]
  }
  # permissão pra Lambda entregar a mensagem na DLQ quando esgota os
  # retries automáticos da invocação assíncrona (S3 → Lambda)
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.ocr_textract_dlq.arn]
  }
}

resource "aws_iam_role_policy" "ocr_textract" {
  name   = "ocr-textract-permissions"
  role   = aws_iam_role.ocr_textract.id
  policy = data.aws_iam_policy_document.ocr_textract.json
}

# ── DLQ + alarme (mesmo padrão de sqs.tf/observability.tf pra fila principal) ─

resource "aws_sqs_queue" "ocr_textract_dlq" {
  name                      = "${local.name}-ocr-textract-dlq"
  message_retention_seconds = 1209600 # 14 dias
}

resource "aws_cloudwatch_metric_alarm" "ocr_textract_dlq_not_empty" {
  alarm_name          = "${local.name}-ocr-textract-dlq-nao-vazia"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.ocr_textract_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# ── Função ─────────────────────────────────────────────────────────────────

resource "aws_lambda_function" "ocr_textract" {
  function_name = "${local.name}-ocr-textract"
  role          = aws_iam_role.ocr_textract.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"

  filename         = data.archive_file.ocr_textract.output_path
  source_code_hash = data.archive_file.ocr_textract.output_base64sha256

  # PDF passa pelo fluxo assíncrono (StartDocumentTextDetection + polling em
  # GetDocumentTextDetection, orçamento de 90s no handler — ver
  # POLL_ORCAMENTO_MS em src/lambdas/ocr-documento-textract/handler.ts) —
  # timeout da lambda precisa cobrir esse orçamento + download/upload.
  # Imagem (caminho síncrono) termina bem antes disso.
  timeout     = 120
  memory_size = 512

  reserved_concurrent_executions = var.ocr_textract_concorrencia_maxima

  environment {
    variables = {
      OUTPUT_PREFIX = "extraidos-textract/"
    }
  }

  dead_letter_config {
    target_arn = aws_sqs_queue.ocr_textract_dlq.arn
  }

  depends_on = [aws_cloudwatch_log_group.ocr_textract]
}

resource "aws_lambda_permission" "ocr_textract_s3" {
  statement_id  = "AllowInvokeFromS3Documentos"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ocr_textract.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.documentos.arn
}

# ── Gatilho: evento de upload no bucket de documentos ────────────────────────
# aws_s3_bucket_notification é singleton por bucket — se este bucket algum
# dia precisar de outro gatilho (outra lambda, SNS, SQS), TEM que entrar
# neste mesmo resource, não em um novo (senão o Terraform sobrescreve).

resource "aws_s3_bucket_notification" "documentos" {
  bucket = aws_s3_bucket.documentos.id

  dynamic "lambda_function" {
    for_each = toset([".jpg", ".jpeg", ".png", ".pdf"])
    content {
      lambda_function_arn = aws_lambda_function.ocr_textract.arn
      events              = ["s3:ObjectCreated:*"]
      filter_prefix       = "documentos/"
      filter_suffix       = lambda_function.value
    }
  }

  depends_on = [aws_lambda_permission.ocr_textract_s3]
}
