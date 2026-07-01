# Maria Chat — Máquinas de Estado

> Estados do ciclo de vida da conversa (campo `Conversation.status`), do macro-
> fluxo de atendimento e do subfluxo de KYC. Notação Mermaid `stateDiagram-v2`.

---

## 1. Ciclo de vida da Conversation (`status`)

Valores reais do campo: `active` | `completed` | `abandoned`.

```mermaid
stateDiagram-v2
    [*] --> active: primeira mensagem
    active --> active: nova mensagem (resume)
    active --> completed: atendimento encerrado (enviar_dados / encerramento)
    active --> abandoned: TTL de inatividade (job de limpeza)
    completed --> [*]
    abandoned --> [*]

    note right of abandoned
        Job de limpeza expira conversas
        active inativas há > CONVERSA_TTL_DIAS (~30).
    end note
```

---

## 2. Macro-fluxo do atendimento (fluxo DPERJ completo)

Estados de negócio percorridos pelo cidadão. Cada `[INTERRUPT]` pausa aguardando
resposta (padrão multi-turn do LangGraph).

```mermaid
stateDiagram-v2
    [*] --> Saudacao
    Saudacao --> ConsentimentoLGPD

    ConsentimentoLGPD --> Encerrado: recusa (RN-01)
    ConsentimentoLGPD --> IdentificacaoCPF: aceita

    IdentificacaoCPF --> Cadastro: CPF não encontrado
    IdentificacaoCPF --> ConfirmaDados: CPF encontrado
    Cadastro --> KYC
    ConfirmaDados --> KYC

    state KYC {
        [*] --> AguardandoSelfie
        AguardandoSelfie --> Confirmado: selfie ok
        AguardandoSelfie --> AguardandoSelfie: falhou, tentar de novo
        Confirmado --> [*]
    }

    KYC --> CasosEmAberto

    CasosEmAberto --> TrataCaso: tem caso + quer tratar
    CasosEmAberto --> Triagem: sem caso / não quer
    TrataCaso --> Encerramento

    state Triagem {
        [*] --> Relato
        Relato --> Classificacao: IA + RAG
        Classificacao --> ExtracaoAntecipada
        ExtracaoAntecipada --> [*]
    }

    Triagem --> Coleta

    state Coleta {
        [*] --> PerguntasServico
        PerguntasServico --> DadosPessoais
        DadosPessoais --> DadosResidenciais
        DadosResidenciais --> DadosContato
        DadosContato --> [*]
    }

    Coleta --> AcompanharProcesso: tema processo
    AcompanharProcesso --> Encerramento
    Coleta --> Encerramento: demais temas

    state Encerramento {
        [*] --> MontaResumo
        MontaResumo --> EnviaDPERJ
        EnviaDPERJ --> ComProtocolo: sucesso
        EnviaDPERJ --> SemProtocolo: falha (fila retry)
        ComProtocolo --> [*]
        SemProtocolo --> [*]
    }

    Encerramento --> Encerrado
    Encerrado --> [*]
```

---

## 3. Subfluxo — Acompanhar Processo (PDPJ)

```mermaid
stateDiagram-v2
    [*] --> ConsultaPDPJ: por CPF (cpfCnpjParte)
    ConsultaPDPJ --> SemProcesso: vazio / token 401
    ConsultaPDPJ --> ListaProcessos: há processos
    ListaProcessos --> Selecao: cidadão escolhe
    Selecao --> ResumoIA: busca detalhe + Bedrock
    ResumoIA --> [*]
    SemProcesso --> [*]: degrada (segue sem listar)
```

---

## 4. Retry de envio à DPERJ (fila)

```mermaid
stateDiagram-v2
    [*] --> Enviando
    Enviando --> Concluido: 200 { protocolo }
    Enviando --> NaFila: falha
    NaFila --> Reenviando: EventBridge (job agendado)
    Reenviando --> Concluido: sucesso
    Reenviando --> NaFila: falha (incrementa tentativas)
    Concluido --> [*]
```

---

## Mapeamento estado → campo persistido

| Máquina | Onde é observável |
|---|---|
| Conversation.status | `Conversation.status` (active/completed/abandoned) |
| Macro-fluxo | posição no checkpoint LangGraph + `Conversation.ultimaEtapa` |
| Dados coletados por estado | `Conversation.dadosColetados` / `GraphState.dadosColetados` |
| Encerramento | `Conversation.protocoloDperj`, `resumo`, `metadados`, `completedAt` |
| Fila DPERJ | `DperjFila` (payload, tentativas) |
