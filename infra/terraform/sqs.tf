# Fase 2 — Fila SQS FIFO: mensagens do WhatsApp/web da api → worker.
# FIFO com MessageGroupId = sessionId → ordem por conversa, sem processar em
# paralelo mensagens do mesmo cidadão. DLQ para o que falhar repetidamente.

resource "aws_sqs_queue" "dlq" {
  name                        = "${local.name}-msgs-dlq.fifo"
  fifo_queue                  = true
  message_retention_seconds   = 1209600 # 14 dias
  content_based_deduplication = false
}

resource "aws_sqs_queue" "msgs" {
  name       = "${local.name}-msgs.fifo"
  fifo_queue = true

  # dedup por id de mensagem enviado pela app (evita reprocessar reentrega da Meta)
  content_based_deduplication = false
  deduplication_scope         = "messageGroup"
  fifo_throughput_limit       = "perMessageGroupId" # alta vazão em FIFO

  visibility_timeout_seconds = 120    # cobre o processamento (Bedrock/Transcribe)
  message_retention_seconds  = 345600 # 4 dias
  receive_wait_time_seconds  = 20     # long polling

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 5
  })
}

output "sqs_queue_url" {
  value       = aws_sqs_queue.msgs.url
  description = "URL da fila de mensagens (usar na api p/ enfileirar)."
}

output "sqs_queue_arn" {
  value = aws_sqs_queue.msgs.arn
}
