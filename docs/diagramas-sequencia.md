# Maria Chat — Diagramas de Sequência

> Fluxos críticos do atendimento, na arquitetura-alvo (Fargate api + SQS + worker).
> Renderizam como imagem no GitHub, VS Code (extensão Mermaid) ou mermaid.live.
> Para exportar PNG/SVG: colar cada bloco em https://mermaid.live.

Participantes recorrentes: **Cidadão**, **Meta** (WhatsApp Cloud API),
**API** (Fargate api/webhook), **SQS**, **Worker** (Fargate/LangGraph),
**RDS** (Postgres/checkpoints), **Bedrock**, **KB** (RAG), **Transcribe**,
**S3**, **PDPJ**, **DPERJ**.

---

## 1. Mensagem de texto → resposta (caminho principal)

```mermaid
sequenceDiagram
    autonumber
    actor Cidadao as Cidadão
    participant Meta as Meta (WhatsApp)
    participant API as API (webhook)
    participant SQS
    participant Worker
    participant RDS as RDS (checkpoint)
    participant Bedrock

    Cidadao->>Meta: envia mensagem
    Meta->>API: POST /webhook/whatsapp
    API-->>Meta: 200 (imediato)
    API->>API: dedupe por message id
    API->>SQS: enfileira (MessageGroupId = sessionId)
    Note over SQS: FIFO — msgs do mesmo cidadão em ordem
    SQS->>Worker: entrega mensagem
    Worker->>RDS: carrega checkpoint (thread_id)
    Worker->>Worker: resume grafo (interruptAfter)
    opt nó de IA (classificar/reescrever)
        Worker->>Bedrock: invoca LLM
        Bedrock-->>Worker: texto
    end
    Worker->>RDS: salva checkpoint
    Worker->>Meta: envia resposta (Graph API)
    Meta->>Cidadao: entrega resposta
```

---

## 2. Mensagem de voz (áudio) → transcrição → fluxo

```mermaid
sequenceDiagram
    autonumber
    actor Cidadao as Cidadão
    participant Meta as Meta (WhatsApp)
    participant API as API (webhook)
    participant SQS
    participant Worker
    participant S3
    participant Transcribe

    Cidadao->>Meta: envia áudio (voz)
    Meta->>API: POST /webhook (type=audio, media id)
    API-->>Meta: 200 (imediato)
    API->>SQS: enfileira (audioId)
    SQS->>Worker: entrega
    Worker->>Meta: baixa mídia (2 passos: metadata → bytes)
    Worker->>S3: grava áudio (audios/, expira ~1 dia)
    Worker->>Transcribe: StartTranscriptionJob (pt-BR, ogg)
    loop poll ≤ 60s
        Worker->>Transcribe: GetTranscriptionJob
        Transcribe-->>Worker: status
    end
    alt COMPLETED
        Transcribe-->>Worker: transcript (texto)
        Worker->>Worker: segue o fluxo normal (como texto)
    else FAILED/timeout
        Worker->>Meta: "não entendi o áudio, pode escrever?"
    end
```

---

## 3. Onboarding: LGPD → CPF → identidade (KYC facial)

```mermaid
sequenceDiagram
    autonumber
    actor Cidadao as Cidadão
    participant Meta as Meta (WhatsApp)
    participant Worker
    participant RDS as RDS (Assistido)
    participant KYC as Página KYC (web)
    participant API as API

    Worker->>Meta: pede aceite do termo LGPD
    Meta->>Cidadao: termo (botão sim/não)
    Cidadao->>Meta: aceita
    Meta->>Worker: (via API→SQS) resposta
    alt recusa LGPD
        Worker->>Meta: encerra atendimento
    else aceita
        Worker->>Meta: pede CPF
        Cidadao->>Meta: informa CPF
        Worker->>RDS: consulta Assistido por CPF
        alt não cadastrado
            Worker->>Meta: oferece cadastro
        else cadastrado
            Worker->>Meta: confirma dados (pergunta fixa)
        end
        Worker->>Meta: envia link do KYC (reconhecimento facial)
        Cidadao->>KYC: abre link e faz selfie
        KYC->>API: POST /kyc (cpf, selfie)
        API-->>KYC: confirmado + score
        API->>Meta: retoma o WhatsApp (push da próxima msg)
        Meta->>Cidadao: "identidade confirmada, vamos continuar"
    end
```

---

## 4. Consulta de processo (tema Acompanhar Processo) — PDPJ + resumo IA

```mermaid
sequenceDiagram
    autonumber
    actor Cidadao as Cidadão
    participant Meta as Meta (WhatsApp)
    participant Worker
    participant PDPJ as API PDPJ (staging)
    participant Bedrock

    Worker->>PDPJ: GET /processos?cpfCnpjParte=CPF
    alt token válido e há processos
        PDPJ-->>Worker: lista de processos
        Worker->>Meta: lista numerada (pergunta fixa)
        Cidadao->>Meta: escolhe (número ou índice)
        Worker->>PDPJ: GET /processos?numeroProcesso=N
        PDPJ-->>Worker: detalhe do processo
        Worker->>Bedrock: resume status em linguagem simples
        Bedrock-->>Worker: resumo
        Worker->>Meta: envia resumo do processo
    else sem processo / token expirado (401)
        PDPJ-->>Worker: vazio / 401
        Worker->>Meta: segue sem listar (degrada)
    end
```

---

## 5. Encerramento → envio à DPERJ (com fila de retry)

```mermaid
sequenceDiagram
    autonumber
    participant Worker
    participant Bedrock
    participant RDS as RDS (Conversation/Fila)
    participant DPERJ as API DPERJ
    participant EB as EventBridge
    actor Cidadao as Cidadão
    participant Meta as Meta (WhatsApp)

    Worker->>Bedrock: gera resumo + metadados do caso
    Bedrock-->>Worker: resumo
    Worker->>RDS: persiste resumo/metadados na Conversation
    Worker->>DPERJ: POST dados do atendimento
    alt sucesso
        DPERJ-->>Worker: { protocolo }
        Worker->>Meta: encerra com protocolo
    else falha
        Worker->>RDS: enfileira payload (DperjFila)
        Worker->>Meta: encerra sem protocolo (degrada)
        Note over EB,RDS: retry assíncrono
        EB->>Worker: dispara processarFila (agendado)
        Worker->>RDS: lê pendências
        Worker->>DPERJ: reenvia
        DPERJ-->>Worker: { protocolo }
    end
    Meta->>Cidadao: mensagem de encerramento
```
