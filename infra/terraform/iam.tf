# Fase 2 — IAM das tasks ECS.
#  - execution role: o agente do ECS puxa imagem (ECR), manda logs e lê os
#    segredos referenciados no task def.
#  - task role: permissões da aplicação em runtime (Bedrock, Transcribe, S3, SQS).

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ── Execution role ────────────────────────────────────────────────────────────
resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ler os segredos injetados como env no container
data "aws_iam_policy_document" "exec_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app.arn, aws_secretsmanager_secret.db.arn]
  }
}

resource "aws_iam_role_policy" "exec_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.exec_secrets.json
}

# ── Task role (aplicação) ─────────────────────────────────────────────────────
resource "aws_iam_role" "task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "task" {
  # Bedrock (LLM + Knowledge Base RAG)
  statement {
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:Retrieve",
      "bedrock:RetrieveAndGenerate",
    ]
    resources = ["*"]
  }
  # Transcribe (áudio → texto)
  statement {
    actions   = ["transcribe:StartTranscriptionJob", "transcribe:GetTranscriptionJob"]
    resources = ["*"]
  }
  # Comprehend (análise de sentimento nas perguntas livres de tema)
  statement {
    actions   = ["comprehend:DetectSentiment"]
    resources = ["*"]
  }
  # Textract AnalyzeID — avaliado como alternativa de OCR de documento na
  # issue #194 (src/core/ocr-documento-textract.ts). Permissão preparada mas
  # a função NÃO é chamada em produção hoje (veredito: não substitui o
  # Bedrock, ver comentário no topo do módulo) — mantida aqui só pra não
  # bloquear se/quando alguém retomar essa avaliação; não usar como sinal de
  # que o Textract está ativo.
  statement {
    actions   = ["textract:AnalyzeID"]
    resources = ["*"]
  }
  # S3 (fichas/áudios)
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${var.s3_bucket}/*"]
  }
  # S3 (documentos do assistido — bucket privado, issue #74)
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.documentos.arn}/*"]
  }
  # S3 ListBucket (documentos) — ação de nível de bucket, não de objeto
  # (resource é o ARN do bucket, sem /*). Necessário pra ListObjectsV2 achar
  # o arquivo mais recente de uma sessão por prefixo (verificação de
  # documento por OCR, card #20260203, src/core/ocr-documento.ts) — o
  # metadado salvo em dadosColetados nunca guarda a key do S3 (LGPD), então
  # não dá pra ir direto no objeto sem listar o prefixo antes.
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.documentos.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["documentos/*"]
    }
  }
  # SQS (api envia, worker consome)
  statement {
    actions = [
      "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage",
      "sqs:GetQueueAttributes", "sqs:GetQueueUrl",
    ]
    resources = [aws_sqs_queue.msgs.arn, aws_sqs_queue.dlq.arn]
  }
  # Secrets (leitura em runtime, se necessário além do env)
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app.arn, aws_secretsmanager_secret.db.arn]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "app-permissions"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}
