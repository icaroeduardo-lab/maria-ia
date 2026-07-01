# Maria Chat — LGPD e Segurança da Informação

> Documento de privacidade e segurança do tratamento de dados pessoais no Maria
> Chat (atendimento da DPERJ). Base: Lei 13.709/2018 (LGPD).
>
> ⚠️ **Não é parecer jurídico.** Deve ser validado pelo Encarregado (DPO) e pela
> assessoria jurídica da DPERJ antes de virar política oficial. Alguns pontos
> marcados como **[AÇÃO]** dependem de decisão institucional.

---

## 1. Papéis (art. 5º LGPD)

| Papel | Quem | Observação |
|---|---|---|
| **Controlador** | DPERJ | Decide finalidade e meios do tratamento. |
| **Operador** | Fornecedor/plataforma Maria Chat | Trata em nome do controlador. |
| **Suboperadores** | AWS (Bedrock, Transcribe, S3, RDS), Meta (WhatsApp), PDPJ, Stripe | Processam dados a mando da operação. |
| **Encarregado (DPO)** | **[AÇÃO]** designar na DPERJ | Canal com titulares e ANPD. |

## 2. Base legal e finalidade

- **Finalidade:** viabilizar o atendimento jurídico gratuito ao cidadão
  hipossuficiente (triagem, coleta, encaminhamento à DPERJ).
- **Base legal (dados comuns):** execução de políticas públicas / cumprimento de
  obrigação legal e exercício regular de competência da Defensoria
  (art. 7º, II e III). **[AÇÃO]** confirmar enquadramento com o jurídico.
- **Dados sensíveis (art. 11):** o relato do caso pode conter dado sensível
  (saúde, situação familiar) e o **KYC usa biometria facial (selfie)**. Requer
  base específica do art. 11 (tutela/política pública ou consentimento). O
  aceite LGPD é registrado antes de qualquer coleta (RN-01).
- **Minimização:** coletar só o necessário ao serviço; a base de conhecimento
  (RAG) é usada apenas para classificar o fluxo, sem armazenar PII.

## 3. Inventário de dados tratados

| Categoria | Dados | Onde vive |
|---|---|---|
| Identificação | CPF, nome, data de nascimento, nome da mãe | RDS (Assistido), Conversation |
| Contato | telefone, e-mail | RDS, Conversation |
| Endereço | CEP, logradouro, número, bairro, município, UF | RDS, Conversation |
| **Biometria (sensível)** | selfie do KYC | processamento KYC / S3 (efêmero) |
| **Conteúdo (pode ser sensível)** | relato do caso, respostas | Conversation, checkpoints LangGraph |
| Voz | áudio da mensagem | S3 (audios/), Transcribe |
| Judicial | processos do assistido (PDPJ) | em trânsito (não persistido) |
| Imagem gerada | ficha do assistido (dados compostos) | S3 (fichas/), efêmero |
| Operação | logs de acesso / auditoria de PII | RDS (AuditLog), CloudWatch |

## 4. Fluxo de dados (por onde passa)

```
Cidadão → WhatsApp/Meta → API → SQS → Worker
   Worker → Bedrock (texto)        [IA: classificação/reescrita]
   Worker → Transcribe + S3 (voz)  [áudio → texto]
   Worker → S3 (ficha/áudio)       [efêmero]
   Worker → PDPJ (processos)       [consulta, não persiste]
   Worker → DPERJ (encaminhamento) [envio final]
   Worker/API → RDS (via RDS Proxy)[Assistido, Conversation, checkpoints]
```

> **Transferência internacional (art. 33):** AWS (região `us-east-1`, EUA) e Meta
> (WhatsApp) processam dados **fora do Brasil**. **[AÇÃO]** garantir salvaguardas
> (cláusulas contratuais, avaliação de adequação) ou avaliar região AWS no Brasil
> (`sa-east-1`) para reduzir a transferência. Ponto de atenção prioritário.

## 5. Retenção e eliminação

| Dado | Retenção atual | Mecanismo |
|---|---|---|
| Ficha (imagem) | ~1 dia | lifecycle do bucket S3 (`fichas/`) |
| Áudio de voz | ~1 dia | lifecycle do bucket S3 (`audios/`) |
| Checkpoints da conversa | ~30 dias após inatividade | job de limpeza (TTL) |
| Selfie do KYC | efêmero (não persistir após verificação) | **[AÇÃO]** confirmar descarte |
| Conversation (resumo/metadados/PII) | **indefinido hoje** | **[AÇÃO]** definir prazo e política de expurgo |
| AuditLog | conforme política | **[AÇÃO]** definir prazo |

> **[AÇÃO] crítico:** definir a retenção da tabela `Conversation` (guarda PII e
> conteúdo do caso) e implementar expurgo/anonimização após o prazo.

## 6. Medidas de segurança (art. 46)

Já implementado no sistema:
- **Criptografia em trânsito** (HTTPS/TLS) em todos os canais e integrações.
- **Segredos em cofre** (Secrets Manager): tokens (PDPJ/WhatsApp), JWT, credenciais
  do banco — nunca no código/repositório.
- **Mascaramento de PII no painel** (CPF/telefone/e-mail) por padrão, no
  servidor; revelação sob demanda.
- **Auditoria de acesso a PII** (`AuditLog`): registra quem revelou, o quê, quando.
- **Controle de acesso por papel** (admin/viewer/superadmin) via JWT.
- **Isolamento multi-tenant** por organização (`thread_id = orgId:sessionId`).
- **Idempotência** no webhook (dedupe por message id).
- **Máscara na imagem da ficha** (CPF/telefone mascarados no artefato gerado).

Recomendado (hardening):
- **[AÇÃO]** criptografia em repouso: RDS e S3 com KMS (confirmar habilitado).
- **[AÇÃO]** RLS nativo no Postgres (hoje o isolamento é em nível de aplicação).
- **[AÇÃO]** rotação automática de segredos (Secrets Manager rotation).
- **[AÇÃO]** política de expurgo da `Conversation` (ver §5).
- **[AÇÃO]** avaliar residência de dados no Brasil (ver §4).

## 7. Direitos do titular (art. 18)

O sistema deve permitir atender:
- **Confirmação/acesso** aos dados — via consulta por CPF (Assistido) + conversas.
- **Correção** — atualização de cadastro pelo próprio fluxo (RF-08).
- **Eliminação/anonimização** — **[AÇÃO]** procedimento e endpoint de expurgo por
  titular (hoje não há fluxo formal).
- **Portabilidade / informação sobre compartilhamento** — **[AÇÃO]** exportação
  sob solicitação.

**[AÇÃO]** publicar canal do titular (Encarregado) e prazo de resposta.

## 8. Compartilhamento com terceiros

| Terceiro | Dado compartilhado | Finalidade |
|---|---|---|
| Meta (WhatsApp) | mensagens, telefone | canal de atendimento |
| AWS Bedrock | texto do relato/perguntas | geração/classificação |
| AWS Transcribe + S3 | áudio de voz | transcrição |
| PDPJ | CPF | consulta de processos |
| DPERJ | dados do atendimento | encaminhamento (finalidade-fim) |
| Stripe | dados de cobrança (organização, não cidadão) | billing |

Todos operam como suboperadores; **[AÇÃO]** contratos com cláusulas de proteção
de dados e a lista de subprocessadores documentada.

## 9. Riscos e mitigações (mini-RIPD)

| Risco | Impacto | Mitigação |
|---|---|---|
| Vazamento de PII no painel | Alto | mascaramento + auditoria + RBAC |
| Token PDPJ/WA vazado ou expirado | Médio | Secrets Manager; degradação graciosa; rotação **[AÇÃO]** |
| Dado sensível no relato/áudio | Alto | minimização; retenção curta; acesso auditado |
| Biometria (selfie) retida indevidamente | Alto | descarte pós-verificação **[AÇÃO]** |
| Transferência internacional (EUA) | Médio-alto | salvaguardas / região BR **[AÇÃO]** |
| Retenção indefinida da Conversation | Médio | política de expurgo **[AÇÃO]** |
| Multi-tenant: vazamento entre orgs | Alto | isolamento por orgId; RLS **[AÇÃO]** |

## 10. Resposta a incidentes

- Detecção via logs/métricas (CloudWatch) e healthcheck.
- **[AÇÃO]** plano formal: conter, avaliar risco, **notificar ANPD e titulares**
  em prazo razoável quando houver risco relevante (art. 48), registrar.
- Auditoria (`AuditLog`) apoia a investigação de acesso indevido a PII.

---

## Resumo dos [AÇÃO] pendentes (priorizado)

1. Definir **retenção/expurgo da `Conversation`** e da biometria do KYC.
2. Tratar **transferência internacional** (salvaguardas ou região BR).
3. Designar **Encarregado (DPO)** e canal do titular.
4. Confirmar **criptografia em repouso** (RDS/S3 + KMS) e rotação de segredos.
5. Contratos/subprocessadores com cláusulas LGPD.
6. Procedimento formal de **direitos do titular** e de **resposta a incidentes**.
