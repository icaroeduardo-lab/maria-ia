# Maria Chat — Documento de Requisitos

> Requisitos funcionais (RF) e não-funcionais (RNF) da plataforma de atendimento
> jurídico conversacional da Defensoria Pública do Estado do Rio de Janeiro (DPERJ).
> Documento de engenharia reversa do sistema atual + metas de produção.

---

## 1. Visão geral

**Maria Chat** substitui o chatbot da DPERJ por uma IA conversacional que atende
o cidadão em linguagem natural (WhatsApp e web), identifica o serviço jurídico,
coleta os dados necessários sem repetir perguntas, confirma identidade e envia o
atendimento ao sistema interno da DPERJ. Gestores configuram os fluxos por um
painel visual, sem código.

**Usuários finais:** cidadãos do RJ sem condições de pagar advogado.
**Usuários operadores:** gestores/servidores da DPERJ.

## 2. Escopo

**Dentro do escopo:**
- Atendimento conversacional por WhatsApp (canal principal) e web.
- Triagem do serviço por IA, coleta guiada, confirmação de identidade (KYC).
- Consulta de casos/processos do assistido e envio à DPERJ.
- Painel administrativo: construtor de fluxos, conversas, analytics, auditoria.
- Multi-tenant (várias organizações), planos e billing.

**Fora do escopo (no momento):**
- Aconselhamento jurídico automatizado / resposta a dúvidas de mérito (a IA
  acolhe e coleta, não dá parecer).
- Integração com a API de produção do PDPJ (só staging por ora).
- Integração real com a Receita/SERPRO para dados de CPF (aguardando credenciais).

## 3. Atores

| Ator | Descrição |
|---|---|
| **Cidadão** | Assistido que busca atendimento via WhatsApp ou web. |
| **Gestor (admin)** | Servidor da DPERJ que configura fluxos, vê conversas/analytics. |
| **Operador (viewer)** | Acesso de leitura ao painel; revelar PII é auditado. |
| **Superadmin** | Gerencia organizações (multi-tenant), planos. |
| **Sistemas externos** | WhatsApp Cloud API, PDPJ, DPERJ, Bedrock, Transcribe, Stripe. |

---

## 4. Requisitos Funcionais

### 4.1 Canal e conversa
- **RF-01** O sistema deve receber e responder mensagens via WhatsApp Business
  (Cloud API), respondendo o webhook em 200 imediato e processando de forma assíncrona.
- **RF-02** O sistema deve suportar o canal web (chat estilo WhatsApp) com a mesma lógica.
- **RF-03** O sistema deve suportar mensagens de texto, botões (sim/não), listas de
  opções e imagens, adaptados a cada canal.
- **RF-04** O sistema deve transcrever mensagens de voz do WhatsApp para texto
  (pt-BR) e seguir o fluxo normalmente; em falha, pedir que o cidadão escreva.
- **RF-05** O sistema deve preservar o contexto multi-turn por conversa
  (`sessionId`), retomando do ponto de interrupção sem reiniciar.
- **RF-06** O sistema deve processar as mensagens de um mesmo cidadão em ordem,
  nunca concorrentemente (evita contaminar o estado do fluxo).

### 4.2 Consentimento e identidade
- **RF-07** O sistema deve solicitar aceite do termo de privacidade (LGPD) antes
  de coletar qualquer dado; recusa encerra o atendimento.
- **RF-08** O sistema deve consultar o assistido por CPF, cadastrar quem não existe
  e atualizar dados de quem já existe.
- **RF-09** O sistema deve confirmar identidade por reconhecimento facial (KYC) via
  link, retomando o WhatsApp automaticamente ao confirmar a selfie.
- **RF-10** A confirmação de dados, confirmação de CPF e seleção de caso devem ser
  perguntas fixas (sem reescrita por IA).

### 4.3 Triagem e coleta
- **RF-11** O sistema deve classificar o serviço jurídico a partir do relato do
  cidadão, usando IA com apoio de RAG (base de conhecimento) apenas para tornar a
  classificação mais assertiva.
- **RF-12** O sistema deve extrair antecipadamente do relato os campos já informados,
  evitando perguntá-los de novo.
- **RF-13** O sistema deve fazer as perguntas pendentes do serviço e da coleta
  (dados pessoais, residenciais, contato) uma a uma.
- **RF-14** O sistema deve reescrever perguntas de forma acolhedora e em linguagem
  simples (configurável), exceto as perguntas fixas (RF-10).
- **RF-15** O sistema deve validar respostas (CPF, telefone, CEP, data, opções) e
  repetir a pergunta quando o valor inferido for inválido.

### 4.4 Casos e processos
- **RF-16** Após o cadastro, o sistema deve verificar casos em aberto do assistido
  e, havendo, perguntar se ele quer tratar de algum.
- **RF-17** No tema "Acompanhar Processo", o sistema deve consultar os processos
  reais do assistido no PDPJ (por CPF), listar para seleção e gerar um resumo do
  status em linguagem simples via IA.

### 4.5 Encerramento e integração
- **RF-18** O sistema deve montar metadados limpos + resumo do caso ao fim do
  atendimento e persistir na conversa.
- **RF-19** O sistema deve enviar os dados coletados à API da DPERJ e apresentar o
  protocolo retornado; sem API configurada, gerar protocolo local (modo mock).
- **RF-20** Em falha de envio à DPERJ, o payload deve entrar em fila de retry e ser
  reprocessado periodicamente; o encerramento degrada para mensagem sem protocolo.

### 4.6 Painel administrativo
- **RF-21** O sistema deve autenticar operadores por JWT e restringir mutações a admin.
- **RF-22** O sistema deve permitir criar/editar/ativar fluxos por um construtor
  visual (nós: mensagem, pergunta, condição, IA, classificar, API, subgrafo,
  subfluxo, atribuir, encerrar), compilados em runtime.
- **RF-23** O sistema deve validar um fluxo (estrutural + compilação) antes de ativá-lo.
- **RF-24** O sistema deve listar conversas com resumo, dados do assistido
  (mascarados) e histórico do chat, e analytics agregados.
- **RF-25** O sistema deve mascarar PII (CPF, telefone, e-mail) no painel e permitir
  revelar sob demanda, registrando quem revelou o quê (auditoria).
- **RF-26** O sistema deve permitir editar o preâmbulo global de estilo/linguagem da IA.

### 4.7 Multi-tenant e billing
- **RF-27** O sistema deve isolar fluxos, conversas e analytics por organização.
- **RF-28** O sistema deve resolver a organização por subdomínio/header (web) e por
  `phone_number_id` (WhatsApp), com credenciais WA por organização.
- **RF-29** O sistema deve aplicar limite de conversas/mês por plano
  (free/pro/enterprise); estouro bloqueia apenas conversas novas.
- **RF-30** O sistema deve integrar cobrança (Stripe): checkout + webhook; sem chave
  configurada, opera em modo mock.

---

## 5. Requisitos Não-Funcionais

### 5.1 Desempenho e escala
- **RNF-01** Suportar volume de **~1,5 milhão de mensagens/mês** (~0,6 msg/s média,
  com picos), com folga para crescimento.
- **RNF-02** A camada de processamento (worker) deve escalar horizontalmente por
  profundidade da fila; a camada de entrada (api) por CPU/requisições.
- **RNF-03** Latência de resposta de texto: alvo **p95 ≤ 5 s** (dominado pela
  latência do Bedrock). Áudio: transcrição em até 60 s (limite do job Transcribe).
- **RNF-04** O webhook do WhatsApp deve responder em **≤ 2 s** (200 imediato), com o
  processamento pesado feito fora do ciclo do webhook.

### 5.2 Disponibilidade e resiliência
- **RNF-05** Disponibilidade alvo **≥ 99,5%** mensal do serviço de atendimento.
- **RNF-06** Falhas em integrações externas (DPERJ, PDPJ) não devem derrubar o
  atendimento: degradar graciosamente (fila de retry, lista vazia, mensagem de fallback).
- **RNF-07** Idempotência no recebimento do WhatsApp (dedupe por message id) para
  reentregas da Meta.
- **RNF-08** Pooling de conexões ao banco (RDS Proxy) para suportar múltiplas
  instâncias sem esgotar conexões.

### 5.3 Segurança e privacidade (LGPD)
- **RNF-09** Dados pessoais em trânsito por HTTPS/TLS; segredos em cofre gerenciado
  (Secrets Manager), nunca no código.
- **RNF-10** PII mascarada por padrão no painel; revelação sempre auditada (usuário,
  alvo, data).
- **RNF-11** Dados efêmeros com expiração automática: ficha do assistido (imagem) e
  áudios expiram por lifecycle (~1 dia); conversas inativas expiram por TTL (~30 dias).
- **RNF-12** Isolamento por organização em nível de aplicação (multi-tenant);
  `thread_id = <orgId>:<sessionId>` impede colisão entre organizações.
- **RNF-13** Controle de acesso por papel (admin/viewer/superadmin) no painel.
- **RNF-14** Base legal e finalidade do tratamento documentadas; consentimento
  LGPD registrado antes da coleta.

### 5.4 Observabilidade e operação
- **RNF-15** Logs e métricas centralizados (CloudWatch), incluindo eventos de
  integração (PDPJ, DPERJ, Transcribe) e saúde do token do WhatsApp.
- **RNF-16** Healthcheck (`/health`) refletindo banco e validade do token WA.
- **RNF-17** Jobs agendados (retry DPERJ, limpeza de conversas, health do token)
  executados de forma confiável (agendador gerenciado).
- **RNF-18** Runbook para rotação de tokens (PDPJ temporário, WhatsApp), deploy e
  teardown de recursos.

### 5.5 Manutenibilidade e portabilidade
- **RNF-19** Fluxos configuráveis por gestores sem código (construtor visual).
- **RNF-20** Infraestrutura como código (CloudFormation) para provisionamento e
  descarte reproduzíveis.
- **RNF-21** Deploy por container (imagem única), com migrações de banco aplicadas
  no start.
- **RNF-22** Ambientes de teste (staging) separados de produção para integrações
  sensíveis (PDPJ), sem uso de dados reais em teste.

### 5.6 Usabilidade e linguagem
- **RNF-23** Linguagem simples, acolhedora e empática, adequada a cidadão leigo e
  vulnerável; tom configurável por preâmbulo global.
- **RNF-24** Emojis contextuais e uso do nome do cidadão, sem repetição robótica.
- **RNF-25** Tudo que existe no fluxo deve funcionar no WhatsApp (canal principal).

---

## 6. Regras de negócio

- **RN-01** Recusa da LGPD encerra o atendimento sem coletar dados.
- **RN-02** Perguntas de confirmação (dados, CPF, seleção de caso) não são
  reescritas por IA.
- **RN-03** RAG é usado só para melhorar a classificação do fluxo, não para
  aconselhar o cidadão.
- **RN-04** Estouro do limite do plano bloqueia apenas conversas novas, nunca as em
  andamento.
- **RN-05** Consultas ao PDPJ usam apenas o ambiente de testes (staging) enquanto
  não houver liberação para dados reais.

## 7. Premissas e restrições

- **PR-01** Token do PDPJ (staging) é temporário; requer rotação manual até haver
  fluxo de refresh do SSO PJe.
- **PR-02** Número do WhatsApp e credenciais da Meta dependem de app publicado e
  números autorizados (restrições da Meta para número de teste).
- **PR-03** Banco Postgres (RDS) mantido como armazenamento primário
  (checkpoints do LangGraph + dados do Prisma).
- **PR-04** LLM padrão: Amazon Bedrock — Claude 3 Haiku; embeddings Titan v2.

## 8. Rastreabilidade (resumo)

| Módulo | RF | RNF principais |
|---|---|---|
| WhatsApp/Canal | RF-01..06 | RNF-04, 07 |
| LGPD/Identidade | RF-07..10 | RNF-09, 10, 14 |
| Triagem/Coleta | RF-11..15 | RNF-03, 23, 24 |
| Casos/Processos | RF-16..17 | RNF-06, RN-05 |
| Encerramento/DPERJ | RF-18..20 | RNF-06 |
| Painel | RF-21..26 | RNF-10, 13, 15 |
| Multi-tenant/Billing | RF-27..30 | RNF-12 |
