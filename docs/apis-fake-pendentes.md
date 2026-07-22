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

## Fluxo: Plantão (reutilizável)

`fluxoId`: ver card Coilab #20260165. Extraído do legado "Violência Doméstica" — a mesma lógica de escala de plantão aparece em `Novo caso.json` e `Falar de um processo_intimação` também, por isso virou subfluxo próprio em vez de embutido.

| Nó | Rota real (fake) | Retorna |
|---|---|---|
| `pl_consultar` | `GET /api/plantao/vigente` | `{status, orgao: {nome, telefone, endereco, municipio, tipo}}` |

Simplificação em relação ao legado: lá, `/plantao/vigente` retornava até 4
plantões concorrentes (idPlantao0..3) e o fluxo fazia cascata de ifs +
checagem de tipo "MUNICIPAL" (não conta como urgência de plantão de
verdade). Aqui a rota já resolve isso — retorna o primeiro plantão ativo
com tipo != MUNICIPAL, se existir. `status: "encontrado"` é o valor literal
comparado pelo nó `condicao`.

Dados de teste seedados (Prisma `PlantaoVigente`): um REGIONAL ativo (Rio de
Janeiro) e um MUNICIPAL ativo (Niterói, não deve aparecer na rota já que é
filtrado).

## Fluxo: Violência Doméstica

`fluxoId`: ver card Coilab #20260164. Embute o subfluxo "Plantão" (ver acima) logo no início — se houver plantão de urgência ativo, encaminha direto; senão segue pro atendimento padrão (RO/processo → órgão → confirmação → notificação).

| Nó | URL fake atual | Método | Deveria fazer |
|---|---|---|---|
| `vd_api_orgao` | `/api/violencia-domestica/orgao-responsavel?indicacaoRO=...` | GET | Busca o órgão responsável por violência doméstica, considerando se há RO (registro de ocorrência) e endereço/preferência da assistida. Espelha o legado `GET /orgao/violencia-domestica`. |
| `vd_api_encaminhar_urgente` / `vd_api_encaminhar` | `/api/violencia-domestica/encaminhar` | POST | Envia o caso pro órgão (urgência via plantão ou padrão). Espelha o legado `POST /encaminhamento/encaminhar`. |

Endereço da assistida foi deliberadamente deixado de fora desta versão —
vai virar fluxo próprio ("Informar endereço", ainda não migrado) e será
plugado aqui depois.

## Fluxo: Recesso (reutilizável)

`fluxoId`: ver card Coilab (a criar). Extraído do legado "Falar de um processo/intimação" — mesma lógica aparece em `Novo caso.json`, `Pessoa presa.json` e `Disponibilizar opções.json`.

| Nó | Rota real (fake) | Retorna |
|---|---|---|
| `rc_consultar` | `GET /api/recesso/vigente` | `{status: "SEM_RECESSO_VIGENTE"\|"RECESSO_VIGENTE", mensagem}` |

Config única (liga/desliga manual via `RecessoVigente.ativo`, sem calendário
forense real ainda) — seed cria desativado por padrão.

## Fluxo: Falar de Processo/Intimação

`fluxoId`: ver card Coilab #20260164. Reaproveita o subfluxo "Recesso" (ver acima).

| Nó | URL fake atual | Método | Deveria fazer |
|---|---|---|---|
| `pi_consultar_processo` | `/api/processo/consultar?numero=...` | GET | Consulta processo pelo número — órgão julgador, assunto, última movimentação, origem. Espelha o legado `GET /processo/consultar/{numero}`. |
| `pi_api_orgao` | `/api/processo/orgao-responsavel?numero=...&preferencia=...&urgencia=...` | GET | Busca o órgão responsável pelo processo, priorizando urgência quando há intimação recente (prazo). Espelha o legado `GET /orgao/atendimento-processual/{idProcesso}`. |
| `pi_api_encaminhar` | `/api/processo/encaminhar` | POST | Envia o caso pro órgão responsável. Espelha o legado `POST /encaminhamento/encaminhar`. |

**Ajuste de UX em relação ao legado**: a pergunta "tem dúvidas sobre o processo?" foi reescrita pra "quer que a Defensoria dê continuidade nesse processo (agendamento/encaminhamento)?" — no legado essa pergunta prometia tirar dúvida mas nunca capturava/respondia o conteúdo, só decidia se continuava. Se quiser capturar a dúvida de verdade no futuro, dá pra trocar por pergunta livre + nó `ia` (RAG já disponível no engine).

## Fluxo: Informar Endereço (reutilizável) — NÃO é fake

`fluxoId`: ver card Coilab #20260164. Diferente dos outros fluxos deste
documento — não precisou de model/rota nova nenhuma:

- **Busca de CEP**: `https://viacep.com.br/ws/{cep}/json/` — API pública real
  e gratuita, chamada direto do nó `api` (URL externa). Sem chave/autenticação.
- **Salvar endereço**: `POST /api/assistidos/atualizar` — rota real já
  existente (`assistidos.ts`), o model `Assistido` já tinha os campos
  (cep, bairro, logradouro, numero, municipio, uf). Testado ponta a ponta:
  persiste de verdade no Postgres de produção.
- Mantém o limite de 3 tentativas de CEP do legado (sem contador dinâmico —
  o engine não tem operação de incremento em `atribuir`, então são 3 blocos
  de pergunta/api/condicao explícitos que convergem no mesmo ponto).
- Confirmação simplificada pra uma pergunta só (legado confirmava CEP, bairro,
  logradouro e número separadamente).
- Campo "complemento" do legado foi removido — o model `Assistido` não tem
  essa coluna; perguntar e não conseguir salvar seria pior que não perguntar.

## Cadastro do assistido + Agendamentos — Gateway Verde (real, com fallback local)

Cards Coilab #20260176 (assistido) / #20260178 (agendamentos), issue maria-ia#108.
Repo do gateway: `GatewayConsultaApiVerde` (`.NET`, sem auth) —
`GET /api/assistido/{cpf}`, `GET /api/agendamentos/{cpf}`, `GET /api/processo/{numero}`.

- **`POST /api/assistidos/consultar`** (`assistidos.ts`) — tenta o Verde primeiro
  (`consultarAssistidoVerde`); se não encontrar (HTTP não-2xx, corpo vazio — o
  gateway não devolve um 404 limpo) ou o gateway estiver fora, cai pro
  fallback local (tabela `Assistido`). Mantém os CPFs de teste seedados
  funcionando (João/Maria/Carlos não existem no Verde de verdade).
- **`POST /api/agendamentos/consultar`** (`agendamentos.ts`) — mesmo padrão.
  O Verde não devolve `tem_agendamentos` nem uma lista pré-formatada — o
  backend monta os dois a partir do array `dados.agendamentos[]` (o engine
  não tem loop/foreach em template, então isso *tem* que ser feito no
  backend, não dá pra interpolar direto de uma URL externa no nó do fluxo).
- **`POST /api/agendamentos/detalhe`** — não bate mais no Prisma pra
  resolver o item selecionado; resolve direto do JSON `agendamentos` que o
  fluxo já carrega (mesmo padrão de índice de `casos/detalhe`), já que
  agendamentos reais (Verde) não têm registro na tabela local.
- **`GET /api/processo/{numero}`** — já integrado direto no nó do fluxo
  (`api_processo_real`, cards #20260174/175) — chamado pela URL externa sem
  passar pelo backend, porque ali é só detalhe de 1 item (sem lista pra
  montar).
- **Card #20260177 (processos por assistido) — BLOQUEADO**: o gateway só
  busca processo por número, não por pessoa. `/api/casos/consultar`
  continua 100% local/fake até esse endpoint existir no Verde.

## Como substituir (checklist, baseado no que já foi feito)

1. Model Prisma novo (schema + migration) — replicar padrão de `Assistido`/`PessoaPresa`.
2. Seed com dados de teste fixos (RG/id fixos, não aleatórios — idempotência entre runs).
3. Rota interna em `src/api/routes/` (sem JWT, comentário "usado pelo fluxo", registrar em `app.ts`).
4. Rodar o seed **em produção** também — migração roda automática no deploy, seed não. Se não puder conectar direto no RDS (VPC privada), usar task avulsa no ECS (mesma rede/task-def do serviço, sem afetar o serviço rodando) — **nunca rodar o `pnpm seed` completo em prod**, ele reescreve os fluxos a partir de `flows.seed.json` desatualizado.
5. No fluxo (via MCP `ajustar_fluxo`): trocar a URL do nó `api`, remover `camposCorpo` se o método for GET (engine ignora corpo em GET), atualizar `nota` se o contrato mudar.
6. Testar via `/admin/test-chat` em produção com os RGs/dados seedados antes de considerar pronto.
