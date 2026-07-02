# CI/CD — workflows do GitHub Actions

Os workflows ficam aqui (e não em `.github/workflows/`) porque o push de arquivos
de workflow exige um token com escopo `workflow`. Para **ativar**, copie-os:

```bash
mkdir -p .github/workflows
cp infra/ci/ci.yml     .github/workflows/ci.yml
cp infra/ci/deploy.yml .github/workflows/deploy.yml
git add .github/workflows && git commit && git push
# (via UI do GitHub ou: gh auth refresh -s workflow)
```

- `ci.yml` — checagem de PR: typecheck + lint + testes (backend) e build (frontend). Não toca AWS.
- `deploy.yml` — build/push das imagens no ECR + deploy no ECS (via OIDC). Requer a
  variável de repositório `AWS_ROLE_ARN`.
