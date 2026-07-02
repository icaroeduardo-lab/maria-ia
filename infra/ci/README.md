# CI/CD — workflow do GitHub Actions

`ci.yml` fica aqui (e não em `.github/workflows/`) porque o push de arquivos de
workflow exige um token com escopo `workflow`. **Para ativar**, copie-o:

```bash
mkdir -p .github/workflows
cp infra/ci/ci.yml       .github/workflows/ci.yml
cp infra/ci/tf-check.yml .github/workflows/tf-check.yml
git add .github/workflows && git commit -m "ci: ativa workflows" && git push
# precisa do escopo: gh auth refresh -s workflow  (ou faça pela UI: Add file)
```

## O que o `ci.yml` faz
- **Pull request → main:** job `test` (tsc + biome lint + testes + build do frontend).
- **Merge na main (push):** `test` e, se passar, `deploy` (`needs: test`):
  build das imagens api/worker → push no ECR → `force-new-deployment` no ECS (OIDC).

Requer a variável de repositório **`AWS_ROLE_ARN`** (output `github_actions_role_arn`
do Terraform). **Não** roda Terraform nem seed de flows — isso continua manual.

## `tf-check.yml`
Em PR que toca `infra/terraform/**`: `terraform fmt -check` + `validate`. **Sem
credenciais AWS** e **sem state** (`-backend=false`). Pega erro de sintaxe/config
cedo, sem tocar em nada.

> `terraform plan` completo (diff dos recursos) fica como evolução — precisa de
> uma role OIDC de leitura + acesso ao state. `apply` segue sempre manual.
