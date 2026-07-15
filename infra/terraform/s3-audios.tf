# Bucket "maria-ia" (issue #75) — provisionado manualmente fora do Terraform
# originalmente (só existia como var.s3_bucket, usado por env.ts/transcribe.ts/
# admin.ts). Este resource passa a gerenciar SÓ o lifecycle de audios/ — não
# recria nada nem mexe em uploads/, imagens/, fichas/ etc.
#
# Precisa de import ANTES do primeiro `terraform plan/apply` (bucket já
# existe de verdade — sem isso o apply tentaria criar um bucket duplicado):
#   terraform import aws_s3_bucket.maria_ia maria-ia
#
# terraform apply continua manual (política do repo raiz) — revisar o plan
# antes de aplicar em produção.
resource "aws_s3_bucket" "maria_ia" {
  bucket = var.s3_bucket
}

# Áudios de voz do WhatsApp (src/core/transcribe.ts) são PII efêmera — só
# precisam existir até o job do AWS Transcribe terminar (segundos/poucos
# minutos). O comentário em transcribe.ts já dizia "expiram por lifecycle
# do bucket", mas essa regra nunca existiu de fato — corrigindo aqui.
resource "aws_s3_bucket_lifecycle_configuration" "maria_ia" {
  bucket = aws_s3_bucket.maria_ia.id

  rule {
    id     = "expirar-audios-efemeros"
    status = "Enabled"

    filter {
      prefix = "audios/"
    }

    expiration {
      days = 2
    }
  }
}
