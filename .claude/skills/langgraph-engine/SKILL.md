---
name: langgraph-engine
description: Invariantes e anatomia do engine LangGraph da Maria (multi-turn, compilação de fluxos, checkpointer, fallbacks de IA) + checklist de como adicionar um tipo de nó novo. Usar SEMPRE que criar/alterar código em src/core/engine/, src/core/graph.ts, src/core/chat.ts ou nós do fluxo.
---

# Engine LangGraph da Maria

Complementa a skill `engine-conventions` (workspace/front): aquela é o
contrato de QUEM CONSTRÓI fluxos; esta é o motor de QUEM MEXE no engine.

## 1. Invariante crítico de multi-turn — NUNCA VIOLAR

O grafo usa `interruptAfter` + checkpointer. Retomar uma conversa:

```typescript
// ✅ 1ª chamada (thread novo):
await graph.invoke({}, config)

// ✅ Chamadas seguintes (resume após interrupt):
await graph.updateState(config, { messages: [new HumanMessage(msg)] })
await graph.invoke(null, config)   // null = continua do checkpoint

// ❌ NUNCA — reinicia o grafo do __start__ ignorando o checkpoint:
await graph.invoke({ messages: [...] }, config)
```

Regra em `src/core/chat.ts`: `prevLen > 0` → updateState + `invoke(null)`.
Qualquer caminho novo que invoque o grafo (rotas, jobs, testes) segue isso.

## 2. Anatomia da compilação (`src/core/engine/builder.ts`)

`buildGraphFromFlow(flow, subflows)` transforma o JSON `{nodes, edges}` em
grafo executável:

- **Pergunta vira 3 nós**: `gate_<id>` (skip se a `chave` já está em
  `dadosColetados`) → `<id>` (envia a pergunta; entra em `interruptAfter`)
  → `cap_<id>` (captura a resposta no resume). Edges de entrada apontam pro
  gate; edges de saída partem do cap.
- **Subfluxos são expandidos inline** com ids prefixados `sf_<nodeId>_`;
  nós-folha com `data.saida` casam com o `label` da edge de saída do nó
  subfluxo no pai.
- **Condição/classificar roteiam pelo `label`** da edge (lowercase); `"*"`
  ou sem label = default. Sim/não normaliza pra `"true"`/`"false"`.
- **Nós inalcançáveis são podados** antes de compilar (LangGraph rejeitaria
  UnreachableNode) — remover nó no builder do painel nunca quebra o engine.
- **Cache de grafo compilado** (`graphDoFlow`): chave = `flow.id`, versão =
  `updatedAt` do flow + subflows. Save no painel invalida sozinho.
- **Cache de reescrita** é por hash de `texto|tipo|tom|styleVersion` — por
  isso mudar o ID de um nó não afeta, mas mudar o TEXTO regenera (custo
  Bedrock pontual). `semReescrita: true` pula IA.

## 3. Checkpointer e estado

- `PostgresSaver` com `DATABASE_URL`; fallback `SqliteSaver`
  (`./data/checkpoints.db` — o `mkdirSync` de `graph.ts` garante o dir no CI).
- `thread_id` = sessionId (`wa:<numero>` no WhatsApp; `test:<flowId>:<id>`
  no chat de teste do painel — isolado de produção).
- Estado (`GraphAnnotation`): `messages`, `dadosColetados` (merge raso por
  chave), `lgpdAceito`, `categoria`, `canal`, `protocolo`...
  `dadosColetados.tom` guia a reescrita (sentimento V1/V2).

## 4. Fallbacks de IA — manter SEMPRE

Todo ponto de IA degrada sem Bedrock (é contrato, testado em
`test/fluxo.test.ts` com credenciais falsas):
- `classificarTexto` → matcher por palavra-chave
- `extrairDoRelato` → `{}` (só não pré-preenche)
- `reescreverPergunta` → texto original
Código novo com LLM segue o padrão: try/catch com caminho determinístico.

## 5. Checklist: adicionar um TIPO DE NÓ novo

Nesta ordem, nada opcional:

1. **`src/core/engine/builder.ts`**: tipo no union de `FlowNode["type"]`,
   campos em `FlowNode["data"]` (comentados), case em `criarNode()` e — se
   pausar esperando o usuário — a trinca gate/cap + `interrupts.push`.
2. **`src/core/engine/validar.ts`**: regras estruturais do nó (campos
   obrigatórios → erro; suspeitos → aviso).
3. **`test/fluxo.test.ts`**: cenário de integração compilando um fluxo com
   o nó novo (multi-turn se ele interromper).
4. **`docs/openapi.yaml`**: enum do `FlowNode.type` (schema) — o guard não
   pega enum, mas o front gera types daqui.
5. **Front** (`maria-ia-front-end`): paleta (`nos-builder.ts`/`paleta-nos`),
   painel de propriedades, e o enum `TIPOS_NO` de `pagina-builder.tsx`
   (é `satisfies` do contrato — quebra em compile-time até atualizar).
6. **Docs**: `docs/guia-frontend.md` §2.2 + skill `engine-conventions`
   (workspace e front).

Depois: `/sync-contrato` no front. PRs separados por repo, mesma label de
card.

## 6. Onde cada coisa mora

| Peça | Arquivo |
|---|---|
| Compilador de fluxos | `src/core/engine/builder.ts` |
| Validação estrutural | `src/core/engine/validar.ts` |
| IA (classificar/extrair/reescrever) | `src/core/engine/ia.ts` |
| Sentimento V2 (Comprehend) | `src/core/engine/sentimento.ts` |
| Resolução de campos/interpolação | `src/core/engine/campos.ts` |
| Grafo estático (fallback) + checkpointer | `src/core/graph.ts` |
| Orquestração de conversa | `src/core/chat.ts` |
| Content blocks → WhatsApp | `src/core/channels/payloads.ts` |
