# CloudFront na frente do bucket "maria-ia" (imagens de nó de mensagem, ex:
# imagens/771e5379-0f5f-4056-aadc-70ab4f1876e8.jpg usada no node m1 do fluxo
# MariaIA) — só acelera/cacheia leitura, NÃO muda a permissão do bucket.
#
# Diferente do CloudFront do painel (painel.tf, OAC + bucket privado): aqui o
# bucket "maria-ia" já é público hoje (URLs diretas tipo
# https://maria-ia.s3.us-east-1.amazonaws.com/imagens/... espalhadas em nodes
# de fluxo existentes, via mcp-maria-flows). Trocar pra privado com OAC
# quebraria toda URL direta já salva em `data.imagem` de qualquer fluxo —
# fora de escopo aqui. Origin aponta pro endpoint REST público do S3 mesmo
# (sem OAC), CloudFront só põe cache na frente.
#
# terraform apply continua manual (política do repo raiz) — revisar o plan
# antes de aplicar em produção. Depois de aplicado, trocar `data.imagem` dos
# nodes que devem usar o domínio novo via mcp-maria-flows (URL antiga
# continua funcionando igual, é so servida sem cache).

resource "aws_cloudfront_distribution" "maria_ia_imagens" {
  enabled     = true
  comment     = "Cache de assets públicos do bucket maria-ia (imagens de fluxo)"
  price_class = "PriceClass_100" # NA + Europa (menor custo)

  origin {
    domain_name = aws_s3_bucket.maria_ia.bucket_regional_domain_name
    origin_id   = "s3-maria-ia-publico"
  }

  default_cache_behavior {
    target_origin_id       = "s3-maria-ia-publico"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # managed policy CachingOptimized
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

output "maria_ia_imagens_cloudfront_url" {
  value       = "https://${aws_cloudfront_distribution.maria_ia_imagens.domain_name}"
  description = "Domínio CloudFront pra servir assets do bucket maria-ia mais rápido (trocar em data.imagem dos nodes que quiser migrar)."
}
