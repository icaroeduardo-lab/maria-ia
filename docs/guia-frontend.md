# Guia do Frontend — Painel Admin Maria Chat

> Especificação do que um frontend (repo separado) precisa ter para operar a
> plataforma por completo. A API é a fonte da verdade: contrato completo em
> `docs/openapi.yaml`, navegável no Swagger UI em `/docs`.
> O CI garante que o spec nunca diverge das rotas reais (`test/openapi.test.ts`).

---

## 1. Autenticação

| O quê | Como |
|---|---|
| Login | `POST /auth/login` `{ email, senha }` → `{ token, user }` |
| Sessão | JWT expira em **8h** — tratar 401 globalmente e voltar ao login |
| Envio | header `Authorization: Bearer <token>` em tudo sob `/admin` |
| Papéis | `admin` (tudo) e `viewer` (leitura) — **esconder** botões de mutação p/ viewer; a API já bloqueia server-side (`exigirAdmin`) |
| Quem sou | `GET /auth/me` → dados do usuário logado |

Sem banco configurado a API responde **503** em `/admin/*` — exibir aviso
"banco não configurado" em vez de tela quebrada.

---

## 2. Páginas necessárias

### 2.1 Fluxos (lista)
- `GET /admin/flows` → lista (id, name, active, datas). Só **um** flow fica
  ativo por vez.
- Ações: criar (`POST /admin/flows`), ativar (`POST /admin/flows/{id}/activate`
  — desativa os demais automaticamente), desativar, excluir.
- **Ativar troca o fluxo em produção em runtime, sem deploy** — pedir
  confirmação explícita.

### 2.2 Builder visual (canvas)
Editor de grafo (ex: React Flow). O flow é JSON `{ nodes, edges }`:

```jsonc
// FlowNode — ver src/core/engine/builder.ts (interface FlowNode)
{
  "id": "p_nome",
  "type": "pergunta",          // tipos na tabela abaixo
  "position": { "x": 100, "y": 200 },  // só o canvas usa; engine ignora e preserva
  "data": { /* campos por tipo — tabela abaixo */ }
}
// FlowEdge
{ "id": "e1", "source": "p_nome", "target": "cond1", "label": "true" }
```

| Tipo de nó | Campos de `data` | Comportamento |
|---|---|---|
| `mensagem` | `texto`, `imagem` (url), `textoAntes` (bool), `ctaUrl` + `ctaTexto` (botão-link, ≤20 chars) | envia e segue |
| `pergunta` | `texto`, `chave`, `tipoPergunta`, `opcoes[]`, `imagem`, `semReescrita` (bool) | pergunta e **pausa** esperando resposta |
| `condicao` | `campo` (de `dadosColetados`) | roteia pela edge cujo `label` = valor |
| `classificar` | `chave`, `opcoes[]` (categorias), `prompt`, `usarRag` | LLM classifica o relato → roteia pelo label |
| `ia` | `prompt`, `usarRag` | resposta livre do LLM |
| `api` | `url`, `metodo` (GET/POST), `chave` (onde grava resposta) | chama API; url relativa resolve no próprio server |
| `subfluxo` | `refFlowId`, `titulo` | embute outro flow (tema reutilizável) |
| `atribuir` | `chave`, `valor` | grava valor fixo em `dadosColetados` |
| `encerrar` | — | envia dados à DPERJ + mensagem final com protocolo |

`tipoPergunta`: `texto` \| `sim_nao` \| `opcoes` \| `cpf` \| `telefone` \| `cep` \| `data`

**Regras de fiação que o builder DEVE respeitar/exibir:**
- Edges saindo de `condicao`/`classificar` usam `label` como valor esperado;
  `"*"` (ou sem label) = rota default.
- **Convenção sim/não**: valores normalizam para `"true"`/`"false"` (ids dos
  botões do WhatsApp) — labels das edges de uma condição sobre pergunta
  `sim_nao` devem ser `true`/`false`, não "sim"/"não". O builder deve sugerir
  isso automaticamente.
- **Skip-gate (automático)**: pergunta cuja `chave` já está preenchida é pulada
  pelo engine — vale exibir isso no canvas (ex: badge "pula se já respondida").
- `semReescrita: true` = texto fixo, IA não reescreve (usar em LGPD, links,
  textos jurídicos que não podem variar).
- Interpolação `{{chave}}` funciona em `texto`, `imagem`, `ctaUrl` e `url`
  (ex: `"Olá {{nome}}"`, `{{kyc.url}}`) — oferecer autocomplete das chaves
  usadas no flow.
- Sub-flows: nó-folha do sub-flow pode nomear a saída via `data.saida`, que
  casa com o `label` da edge de saída do nó `subfluxo` no flow pai.

**Validação:** `GET /admin/flows/{id}/validar` → `{ ok, erros[], avisos[] }`
(estrutural + compilação real + existência de subfluxos referenciados).
Rodar ao salvar e antes de ativar; bloquear ativação com erros.

### 2.3 Chat de teste
`POST /admin/test-chat` `{ flowId?, sessionId, message? }` →
`{ messages[], done, dadosColetados }`.
- 1ª chamada: só `sessionId` (sem `message`) → mensagens iniciais.
- Seguintes: com `message` → continua a conversa (multi-turn real, isolado
  dos checkpoints de produção via prefixo `test:`).
- `flowId` omitido = grafo estático. Flow inválido → 422 com o motivo.
- Renderizar os **content blocks** (seção 3). Gerar `sessionId` novo a cada
  "reiniciar teste".

### 2.4 Conversas
- `GET /admin/conversations?status&categoria&channel&page` (paginado, 50/página).
- Detalhe: `GET /admin/conversations/{sessionId}` — PII do assistido vem
  **mascarada** por padrão.
- Histórico de mensagens: `GET /admin/conversations/{sessionId}/historico`.
- **Revelar PII**: `POST /admin/conversations/{sessionId}/revelar` (só admin,
  gera auditoria) — UX: botão explícito "revelar dados", nunca automático.

### 2.5 Assistidos
CRUD em `/admin/assistidos` (paginado, busca). Mesma regra de máscara/reveal.

### 2.6 Configurações
`GET/PUT /admin/config` → `{ estiloPrompt, conversacional, padrao }`.
- `estiloPrompt`: preâmbulo de estilo global da IA (textarea grande; `padrao`
  traz o default pra botão "restaurar").
- `conversacional`: liga/desliga a reescrita acolhedora das perguntas.
- **Salvar invalida o cache de reescrita** (styleVersion muda) — avisar que as
  próximas perguntas serão regeradas (custo Bedrock pontual).

### 2.7 Dashboard
`GET /admin/analytics/summary` → totais, conversas por dia, por categoria,
por canal, taxa de conclusão. Gráficos simples (linha + pizza) bastam.

### 2.8 Usuários e Auditoria (só admin)
- `GET/POST /admin/users` — criar operador (email, senha, role).
- `GET /admin/audit?page` — quem revelou PII de quem, quando.

---

## 3. Content blocks (renderização do chat)

Mensagens da IA vêm como array de blocos — o chat de teste (e qualquer chat
web) deve renderizar todos:

```jsonc
{ "type": "text", "text": "..." }                          // texto (markdown leve: **negrito**)
{ "type": "image_url", "image_url": { "url": "..." } }     // imagem
{ "type": "boolean", "trueLabel": true, "falseLabel": false } // botões Sim/Não → responder "true"/"false"
{ "type": "options", "options": ["a", "b"] }               // lista → responder com o TEXTO da opção
{ "type": "cta_url", "url": "...", "text": "Abrir" }       // botão que abre link
```

Resposta de `boolean` envia o **id** (`"true"`/`"false"`), não o rótulo —
mesmo contrato do WhatsApp.

---

## 4. O que a API ainda NÃO tem (planejar junto com o front)

| Lacuna | Impacto no front | Sugestão |
|---|---|---|
| Versionamento de flow | editar sobrescreve; sem rollback/draft | back: tabela de versões; front: histórico + "restaurar" |
| Autosave/lock de edição | dois editores se sobrescrevem | lock otimista via `updatedAt` (409 se mudou) |
| Multi-org | v2 é single-org (DPERJ) | só se o produto virar multi-tenant |
| ~~Upload de imagem~~ | **resolvido**: `POST /admin/upload` (multipart `file`, jpeg/png/webp ≤5MB) → `{ url }` pública permanente | front: dropzone no editor de nó; usar a url no campo `imagem` |
| Websocket/streaming | test-chat é request/response | suficiente pra V1 |

---

## 5. Checklist de integração

- [ ] Login JWT + tratamento global de 401 (expira em 8h) e 503 (sem banco)
- [ ] Esconder mutações para role `viewer`
- [ ] Builder produz JSON no formato da seção 2.2 (validar com `/validar` antes de ativar)
- [ ] Canvas preserva `position` e ids estáveis dos nós (id muda = cache de reescrita reseta)
- [ ] Chat de teste renderiza os 5 content blocks e responde `boolean` por id
- [ ] PII sempre mascarada; reveal explícito e auditado
- [ ] Confirmação antes de ativar/excluir flow
- [ ] CORS: a API já aceita qualquer origem (`origin: true`)
