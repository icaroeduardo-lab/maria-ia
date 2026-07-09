# Hospedagem do painel admin (maria-ia-front-end): S3 privado + CloudFront (OAC).
# Deploy pelo CI do front (main → build → s3 sync → invalidation), via role gha.
# Sem token no bundle: o painel pede o token na primeira carga (front#53).

resource "aws_s3_bucket" "painel" {
  bucket = "${local.name}-painel"
}

resource "aws_s3_bucket_public_access_block" "painel" {
  bucket                  = aws_s3_bucket.painel.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# leitura APENAS via CloudFront (OAC)
resource "aws_cloudfront_origin_access_control" "painel" {
  name                              = "${local.name}-painel"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "painel_bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.painel.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.painel.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "painel" {
  bucket = aws_s3_bucket.painel.id
  policy = data.aws_iam_policy_document.painel_bucket.json
}

resource "aws_cloudfront_distribution" "painel" {
  enabled             = true
  comment             = "Painel admin Maria Chat"
  default_root_object = "index.html"
  price_class         = "PriceClass_100" # NA + Europa (menor custo)

  origin {
    domain_name              = aws_s3_bucket.painel.bucket_regional_domain_name
    origin_id                = "s3-painel"
    origin_access_control_id = aws_cloudfront_origin_access_control.painel.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-painel"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # managed policy CachingOptimized
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # SPA: rota desconhecida cai no index.html (roteamento client-side)
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true # domínio próprio entra depois (ACM)
  }
}

output "painel_bucket" {
  value       = aws_s3_bucket.painel.bucket
  description = "Setar como variável PAINEL_BUCKET no repo do front."
}

output "painel_distribution_id" {
  value       = aws_cloudfront_distribution.painel.id
  description = "Setar como variável PAINEL_DISTRIBUTION_ID no repo do front."
}

output "painel_url" {
  value       = "https://${aws_cloudfront_distribution.painel.domain_name}"
  description = "URL do painel em produção."
}
