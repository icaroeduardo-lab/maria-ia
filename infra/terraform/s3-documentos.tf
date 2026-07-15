# Bucket privado para documentos enviados pelo assistido durante o atendimento
# (issue #74 — comprovante de renda, identidade etc). Nunca público: LGPD proíbe
# documento sensível em bucket público (ver skill lgpd do repo raiz). Diferente
# de maria_ia (s3-audios.tf, bucket público legado só com lifecycle gerenciado
# aqui), este bucket é criado E gerenciado 100% pelo Terraform desde o início —
# sem import necessário.

resource "aws_s3_bucket" "documentos" {
  bucket = "${local.name}-documentos"
}

resource "aws_s3_bucket_public_access_block" "documentos" {
  bucket                  = aws_s3_bucket.documentos.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documentos" {
  bucket = aws_s3_bucket.documentos.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Documentos são PII sensível e só precisam existir até o fluxo consumir o
# metadado (nome/tamanho/mimeType) — os bytes em si não são reprocessados
# depois do upload. Retenção curta por padrão (var.documentos_retencao_dias).
resource "aws_s3_bucket_lifecycle_configuration" "documentos" {
  bucket = aws_s3_bucket.documentos.id

  rule {
    id     = "expirar-documentos"
    status = "Enabled"

    filter {
      prefix = "documentos/"
    }

    expiration {
      days = var.documentos_retencao_dias
    }
  }
}
