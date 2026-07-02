# Maria Chat — Diagrama de Classes

> Modelo de classes/tipos do domínio. Três recortes: entidades persistentes
> (Prisma), tipos do motor de fluxo e serviços (módulos com operações).
> Notação UML em Mermaid `classDiagram`. `-->` associação, `*--` composição,
> `..>` dependência/referência lógica (sem FK física).

---

## 1. Entidades persistentes (Prisma)

```mermaid
classDiagram
    class Flow {
        +string id  «PK»
        +string name
        +Json nodes  «FlowNode[]»
        +Json edges  «FlowEdge[]»
        +boolean active
        +DateTime createdAt
        +DateTime updatedAt
    }
    class Conversation {
        +string id  «PK»
        +string sessionId  «UK»
        +string channel
        +string? flowId
        +string status
        +string? categoria
        +string? ultimaEtapa
        +Json dadosColetados
        +string? resumo
        +Json? metadados
        +string? protocoloDperj
        +DateTime startedAt
        +DateTime? completedAt
    }
    class Assistido {
        +string id  «PK»
        +string cpf  «UK»
        +string nome
        +string? dataNascimento
        +string? nomeMae
        +string situacao
        +string? municipio
        +string? uf
        +string? telefone
        +string? email
        +string? cep
        +string? bairro
        +string? logradouro
        +string? numero
    }
    class Caso {
        +string id  «PK»
        +string identificador
        +string tipo
        +string status
        +string assistidoId  «FK»
        +DateTime criadoEm
    }
    class User {
        +string id  «PK»
        +string email  «UK»
        +string senha  «hash»
        +string nome
        +string role
    }
    class AuditLog {
        +string id  «PK»
        +string userId
        +string userEmail
        +string acao
        +string alvoTipo
        +string alvoId
        +DateTime criadoEm
    }
    class Config {
        +string id  «PK "default"»
        +string estiloPrompt
        +boolean conversacional
        +DateTime updatedAt
    }
    class DperjFila {
        +string id  «PK»
        +Json payload
        +int tentativas
        +string? ultimoErro
        +DateTime criadoEm
    }

    Assistido "1" *-- "*" Caso : casos (cascade)
    Conversation ..> Flow : flowId (lógico)
    AuditLog ..> User : userId (lógico)
    AuditLog ..> Assistido : alvoId (lógico)
    Conversation ..> Assistido : por CPF (lógico)
```

> Fora do Prisma: schema `langgraph` (checkpoints/checkpoint_writes/checkpoint_blobs)
> guarda o estado das conversas por `thread_id` — gerenciado pelo LangGraph.

---

## 2. Motor de fluxo (tipos)

```mermaid
classDiagram
    class FlowJSON {
        +string id
        +FlowNode[] nodes
        +FlowEdge[] edges
    }
    class FlowNode {
        +string id
        +NodeType type
        +Position? position
        +NodeData data
    }
    class NodeData {
        +string? titulo
        +string? texto
        +string? imagem
        +string? chave
        +TipoPergunta? tipoPergunta
        +string[]? opcoes
        +string? campo
        +string? prompt
        +boolean? usarRag
        +string? url
        +string? metodo
        +string? servico
        +string? refFlowId
        +string? saida
        +boolean? semReescrita
        +string? valor
    }
    class FlowEdge {
        +string id
        +string source
        +string target
        +string? label
    }
    class Pergunta {
        +string chave
        +string texto
        +boolean obrigatoria
        +TipoPergunta tipo
        +string[]? opcoes
        +string? imagem
        +string? descricao
        +condicao(dados) boolean
        +validar(valor) boolean
    }
    class GraphState {
        +BaseMessage[] messages
        +boolean lgpdAceito
        +string categoria
        +Record dadosColetados
        +string[] perguntasFeitas
        +string ultimaPergunta
        +boolean servicoConcluido
        +string canal
        +string iniciadoEm
        +string protocolo
    }
    class TipoPergunta {
        <<enumeration>>
        texto
        sim_nao
        opcoes
        cpf
        telefone
        cep
        data
    }
    class NodeType {
        <<enumeration>>
        mensagem
        pergunta
        condicao
        ia
        classificar
        api
        subgrafo
        subfluxo
        atribuir
        encerrar
    }
    class ProcessoSimples {
        +string numero
        +string classe
        +string assunto
        +string orgao
        +string instancia
        +boolean ativo
        +string ultimoMovimento
        +string dataUltimoMovimento
        +string[] partes
    }
    class Metadados {
        +object assistido
        +object caso
        +object encaminhamento
        +string protocolo
    }

    FlowJSON "1" *-- "*" FlowNode
    FlowJSON "1" *-- "*" FlowEdge
    FlowNode *-- NodeData
    FlowNode --> NodeType
    NodeData --> TipoPergunta
    Pergunta --> TipoPergunta
    Flow ..> FlowJSON : nodes/edges (Json)
```

---

## 3. Serviços (módulos com operações)

```mermaid
classDiagram
    class ChatService {
        <<service>>
        +processarMensagem(sessionId, message, canal) Result
        -obterGraph(orgId) Graph
    }
    class GraphBuilder {
        <<service>>
        +graphDoFlow(flow, subflows) Graph
        +buildGraphFromFlow(json) Graph
        -expandirSubfluxos(nodes, edges, map) FlowJSON
        -alcancabilidade(nodes, edges) Set
    }
    class Extrator {
        <<service>>
        +extrairDoRelato(relato, perguntas, jaColetados) Record
        +reescreverPergunta(texto, p, state, estilo) string
        +classificarTexto(fala, opcoes, prompt, rag) string
    }
    class ProcessosClient {
        <<service>>
        +consultarPorCpf(cpf) ProcessoSimples[]
        +consultarPorNumero(numero) ProcessoSimples
        +resumirProcesso(p) string
        +listaNumerada(ps) string
    }
    class ResumoService {
        <<service>>
        +montarMetadados(dados) Metadados
        +gerarResumoTexto(m) string
    }
    class Masker {
        <<service>>
        +mascararAssistido(a) object
        +mascararCpf(cpf) string
        +mascararTelefone(tel) string
        +mascararEmail(email) string
    }
    class DperjClient {
        <<service>>
        +enviar(payload) Protocolo
        +processarFila() void
    }

    ChatService ..> GraphBuilder : compila fluxo ativo
    ChatService ..> Conversation : rastreia
    GraphBuilder ..> FlowJSON
    GraphBuilder ..> Pergunta
    GraphBuilder ..> Extrator : nós ia/classificar/pergunta
    GraphBuilder ..> ProcessosClient : nós api (/processos)
    GraphBuilder ..> DperjClient : nó encerrar
    ProcessosClient ..> ProcessoSimples
    ResumoService ..> Metadados
    Masker ..> Assistido
    DperjClient ..> DperjFila : retry em falha
```
