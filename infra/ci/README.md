# CI/CD — workflow do GitHub Actions

`ci.yml` fica aqui (e não em `.github/workflows/`) porque o push de arquivos de
workflow exige um token com escopo `workflow`. **Para ativar**, copie-o:

```bash
mkdir -p .github/workflows
cp infra/ci/ci.yml .github/workflows/ci.yml
git add .github/workflows && git commit -m "ci: ativa workflow" && git push
# precisa do escopo: gh auth refresh -s workflow  (ou faça pela UI: Add file)
```

## O que o `ci.yml` faz
- **Pull request → main:** job `test` (tsc + biome lint + testes + build do frontend).
- **Merge na main (push):** `test` e, se passar, `deploy` (`needs: test`):
  build das imagens api/worker → push no ECR → `force-new-deployment` no ECS (OIDC).

Requer a variável de repositório **`AWS_ROLE_ARN`** (output `github_actions_role_arn`
do Terraform). **Não** roda Terraform nem seed de flows — isso continua manual.
