# HTTPS por domínio: certificado ACM (validação DNS via Route53) + alias do
# domínio para o ALB. A Meta exige webhook HTTPS válido — isso tira a dependência
# do túnel cloudflared.
#
# Requer `domain_name` + `route53_zone_name` (hosted zone no Route53). Vazios =
# nada é criado (segue só HTTP:80). Se o DNS não estiver no Route53, valide o
# certificado manualmente e passe o ARN em `acm_certificate_arn`.

locals {
  usar_dominio = var.domain_name != "" && var.route53_zone_name != ""
  # certificado a usar no listener 443: o criado aqui, ou o override manual
  cert_arn    = local.usar_dominio ? one(aws_acm_certificate_validation.main[*].certificate_arn) : var.acm_certificate_arn
  https_ativo = local.cert_arn != null && local.cert_arn != ""
}

data "aws_route53_zone" "main" {
  count = local.usar_dominio ? 1 : 0
  name  = var.route53_zone_name
}

resource "aws_acm_certificate" "main" {
  count             = local.usar_dominio ? 1 : 0
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle { create_before_destroy = true }
}

# registros DNS de validação do certificado
resource "aws_route53_record" "cert_validation" {
  for_each = local.usar_dominio ? {
    for o in aws_acm_certificate.main[0].domain_validation_options : o.domain_name => {
      name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value
    }
  } : {}

  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.value]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "main" {
  count                   = local.usar_dominio ? 1 : 0
  certificate_arn         = aws_acm_certificate.main[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# aponta o domínio para o ALB
resource "aws_route53_record" "app" {
  count   = local.usar_dominio ? 1 : 0
  zone_id = data.aws_route53_zone.main[0].zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

output "app_url" {
  value       = local.usar_dominio ? "https://${var.domain_name}" : "http://${aws_lb.main.dns_name}"
  description = "URL pública do app (usar como PUBLIC_URL e no webhook da Meta)."
}
