# APIs fake pendentes de substituição

Nós `api` nos fluxos dinâmicos (editados via `maria-flows` MCP, produção) que
apontam pra endpoints que **não existem de verdade** — placeholders criados
durante a construção do subfluxo, aguardando integração real (SEAP/apenado,
agendamento). Cada um tem `nota` no próprio nó do fluxo; este doc é só a
visão consolidada.

Fluxos sem nó `api` nenhum (não listados abaixo): **Orquestrador**,
**Divórcio (protótipo IA)**, **Trabalhista (protótipo IA)**, **Alimentação
(protótipo IA)**, **Fora de competência** — hoje são só coleta de dados
(pergunta/mensagem/condição), sem integração nenhuma ainda.

## Fluxo: Pessoa Presa (protótipo IA)

`fluxoId: cmrnz07ti007blc0j5givi327`

### Já substituídas (rotas reais, `src/api/routes/pessoa-presa.ts`, PR maria-ia#95)

| Nó | Rota real | Retorna |
|---|---|---|
| `api_apenado` | `GET /api/pessoa-presa/consultar-rg?rg=...` | `{encontrado, situacao, nome, tipoPreso, regime, idPessoa, idSeap}` |
| `api_processo` | `GET /api/pessoa-presa/consultar-processo?numero=...` | `{encontrado, numero, origem, idProcesso}` |
| `api_casos` | `GET /api/pessoa-presa/casos?idPessoaPresa=...` | `{tem_casos, status, casos[], lista}` |
| `api_orgao` | `GET /api/pessoa-presa/orgao-responsavel?idSeap=...&preferencia=...` | `{status, orgao}` |
| `api_orgao_liberto` | `GET /api/pessoa-presa/orgao-responsavel-liberto?idSeap=...` | `{status, orgao}` |

Dados de teste seedados (Prisma `PessoaPresa`/`CasoPessoaPresa`/`ProcessoPessoaPresa`):
RG `11111111111` (ATIVO, com órgão) · `22222222222` (ATIVO, sem órgão) ·
`33333333333` (LIBERTADO, sem caso) · `44444444444` (LIBERTADO, com caso
ABERTO) · processo `08012340020258190001` (origem SEEU).

### Ainda fake (pendentes)

| Nó | URL fake atual | Método | Deveria fazer |
|---|---|---|---|
| `api_encaminhar` | `/api/pessoa-presa/encaminhar` | POST | Envia o caso pro órgão escolhido (encaminhamento formal — réu preso urgência ou réu liberto com caso já aberto/órgão achado). Espelha o legado `POST /encaminhamento/encaminhar`. |
| `api_vagas` | `/api/pessoa-presa/consultar-vagas?idOrgao=...&preferencia=...` | GET | Lista horários disponíveis pra agendamento na unidade escolhida. Espelha o legado `GET /agendamento/consultar-vagas-nuspen`. |
| `api_agendar` | `/api/pessoa-presa/agendar` | POST | Confirma o agendamento no horário escolhido. Espelha o legado `POST /agendamento/agendar`. |

Não têm tabela clara pra mockar ainda (agenda/vaga é mais dinâmico que
cadastro de pessoa presa — precisaria de um modelo de disponibilidade, não só
registro fixo). Avaliar quando for a vez de implementar.

## Como substituir (checklist, baseado no que já foi feito)

1. Model Prisma novo (schema + migration) — replicar padrão de `Assistido`/`PessoaPresa`.
2. Seed com dados de teste fixos (RG/id fixos, não aleatórios — idempotência entre runs).
3. Rota interna em `src/api/routes/` (sem JWT, comentário "usado pelo fluxo", registrar em `app.ts`).
4. Rodar o seed **em produção** também — migração roda automática no deploy, seed não. Se não puder conectar direto no RDS (VPC privada), usar task avulsa no ECS (mesma rede/task-def do serviço, sem afetar o serviço rodando) — **nunca rodar o `pnpm seed` completo em prod**, ele reescreve os fluxos a partir de `flows.seed.json` desatualizado.
5. No fluxo (via MCP `ajustar_fluxo`): trocar a URL do nó `api`, remover `camposCorpo` se o método for GET (engine ignora corpo em GET), atualizar `nota` se o contrato mudar.
6. Testar via `/admin/test-chat` em produção com os RGs/dados seedados antes de considerar pronto.
