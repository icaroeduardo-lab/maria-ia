# API de Processos PDPJ (Data Lake / PJe)

Integração usada para consultar os processos do assistido por CPF e resumir o
status em linguagem simples (IA). Substitui o antigo mock/tabela `Caso` local.

> **Status atual:** usando **apenas a API de TESTES (staging)**. A API de
> produção está documentada abaixo para não se perder, mas **não deve ser usada
> agora** — depende de token real e implicaria testar com dados reais de
> cidadãos, o que não é recomendado neste momento.

---

## Ambientes

| Ambiente | Base URL (env `PDPJ_API_URL`) | Uso |
|---|---|---|
| **Testes (staging)** — EM USO | `https://api-processo.stg.data-lake.pdpj.jus.br/processo-api/api/v1` | dados de teste, token temporário |
| **Produção** — NÃO usar agora | `https://api-processo.data-lake.pdpj.jus.br/processo-api/api/v1` | dados reais; exige token de produção |

> A URL de produção segue o padrão do PDPJ (mesma base, sem o subdomínio `.stg`).
> Confirmar com a equipe do PDPJ/Defensoria antes de apontar para produção.

## Autenticação

- Header: `Authorization: Bearer <token>` (env `PDPJ_API_TOKEN`).
- Token do realm PJe (`sso...pje`). **Temporário** (expira em horas no staging).
  Quando expira, a API retorna 401 e o cliente degrada para lista vazia.
- Produção exigirá o fluxo de refresh do token do SSO PJe (client `dp-rj`).

## Endpoints usados

Busca por CPF da parte (lista os processos do assistido):
```
GET {base}/processos?cpfCnpjParte=<CPF só dígitos>
```
Busca por número (detalhe de 1 processo — usado no resumo):
```
GET {base}/processos?numeroProcesso=0808815-60.2025.8.19.0037
```

> **Parâmetro de CPF = `cpfCnpjParte`.** Outros nomes (`documento`, `cpf`,
> `numeroDocumentoParte`) são ignorados pela API e retornam o dataset inteiro.

Resposta: `{ total, content: [ { numeroProcesso, tramitacoes: [ { classe, assunto,
orgaoJulgador, ultimoMovimento, partes, ativo, ... } ] } ] }`.

## Como trocar de ambiente

1. Atualizar `PDPJ_API_URL` e `PDPJ_API_TOKEN` no `.env`, `.env.production` e no
   Railway (`railway variables --set ...`).
2. Redeploy: `railway up --detach` (git push sozinho não deploya).

## Código

- `src/processos.ts` — cliente (`consultarPorCpf`, `consultarPorNumero`,
  `resumirProcesso` via Bedrock) + achatamento do payload.
- `src/routes/processos.ts` — `POST /api/processos/consultar` e `/resumo`.
- Fluxo "Fluxo DPERJ Completo": etapa de casos (`api_casos`) chama
  `/api/processos/consultar`; seleção → nó de resumo IA.

CPF de teste (staging) com 1 processo real: `91829992791`, `04747871179`.
