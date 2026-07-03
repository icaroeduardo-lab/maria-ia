# Estratégia — Cache de reescrita + tom por sentimento

> Corta o maior custo de Bedrock (reescrita de pergunta por mensagem) sem perder
> a personalização nem a sensibilidade emocional. Referência de implementação.

## Problema

Hoje o `reescreverPergunta` (engine/ia.ts) chama o LLM **toda vez que mostra uma
pergunta conversacional** — ou seja, ~1 chamada por mensagem. A ~1,5M msg/mês, é
o principal driver de custo do Bedrock.

A reescrita **não depende do dado específico** do usuário (a regra do prompt é
"acolha o sentimento, NÃO cite os dados") — depende só de **texto da pergunta +
tom + estilo global + nome**. Logo, é **cacheável**.

## Solução em 3 camadas

### 1. Cache de reescrita
- **Chave:** `flowId:nodeId:tom:styleVersion`
  - `styleVersion` = hash do preâmbulo global (`Config.estiloPrompt`).
  - Editar a pergunta/estilo → chave muda → regenera (invalidação correta).
- **Store:** memória por task (v1) → **Redis/ElastiCache** compartilhado (v2).
- **TTL:** só rede de segurança / refresh (7-30 dias). Não é o mecanismo de
  invalidação — quem invalida é a mudança de chave.
- **Pool de variações:** 3-5 versões por (pergunta, tom) → evita texto idêntico
  pra todo mundo (não fica robótico). Seleção da variação = **barata** (random /
  `hash(sessionId)%N`), **nunca** por LLM.
- **Nome:** o cache guarda com `{{nome}}` → `interpolar()` injeta o nome de cada
  usuário no envio. Personalizado mesmo vindo do cache.
- **Quando gerar:** na ativação do fluxo (pré-gera tudo 1×) ou lazy (1ª vez que a
  pergunta aparece).

> A IA **gera** as variações (1× por pergunta/tom). O código **escolhe** ($0).
> Se a IA escolher a variação por mensagem, o cache perde o sentido.

### 2. Tom por sentimento
- Cada pergunta tem variações marcadas por **tom**: `neutro` / `empático` /
  `acolhedor-forte`.
- **Análise de sentimento 1× no início** (no relato) → define o `tom` do
  assistido → guarda em `dadosColetados.tom`.
- Cada pergunta seguinte → pega `variação[nodeId][tom]` do cache. **Zero LLM por
  pergunta.**

### 3. Sentimento — de onde vem
| Caso | Serviço | Por quê |
|---|---|---|
| **Tom inicial** (1× no relato) | **Bedrock, fundido no classify+extração** | já existe a chamada → custo zero extra; rótulos ricos (angustiado/revoltado/calmo) |
| **Re-avaliar tom por turno** (opcional) | **Amazon Comprehend** (`DetectSentiment`, pt) | barato por chamada, não gasta Bedrock; 4 baldes bastam pra "piorou → sobe empatia" |

Chamada única no início (structured output):
```json
{ "categoria": "alimentação", "campos": { ... }, "tom": "angustiado" }
```

## Regras de segurança (público vulnerável)
1. **Tema sensível sobrepõe o sentimento:** violência, saúde grave, etc. →
   força `acolhedor-forte` independente do tom detectado.
2. **Na dúvida, erra pro caloroso:** sentimento incerto → tom mais empático.
3. **Tom pode evoluir:** v1 define no início; evolução = re-avaliar em 1-2
   checkpoints (Comprehend por turno, se quiser).

## Não conflita com skip/extração
Camadas **ortogonais**:
- **Skip-gate / extração** → decide **SE** pergunta (baseado em `dadosColetados`).
- **Cache** → decide **QUAL texto**, se perguntar.
- Pergunta pulada → nem consulta o cache. A ordem varia por usuário; o texto de
  cada pergunta não → cache por `nodeId` funciona igual.

## Custo (antes → depois)
| Uso | Antes | Depois |
|---|---|---|
| Reescrita | ~1,5M chamadas/mês (por msg) | ~0 (amortizada no cache) |
| Classify + extração + **tom** | 2 chamadas | **1** (fundidas) por conversa |
| Resumo final | 1 | 1 por conversa |
| **Bedrock/mês** | ~$1.000-1.500 | **~$300-500** |

## Plano de implementação
1. **Fundir sentimento no classify+extração** (structured output ganha `tom`).
2. **Cache em memória** por `flowId:nodeId:tom:styleVersion` + pool de variações
   com `{{nome}}` → já corta ~90% das chamadas de reescrita.
3. **Pré-gerar na ativação do fluxo** (opcional) → runtime nunca reescreve.
4. **Trocar o store por Redis/ElastiCache** quando quiser compartilhar entre tasks.
5. **Comprehend por turno** (opcional) → rastrear mudança de humor.

## Componentes tocados
- `src/core/engine/ia.ts` — `classificarTexto`/`extrairDoRelato` fundidos + `tom`;
  `reescreverPergunta` passa a consultar o cache.
- `src/core/config.ts` — expor `styleVersion` (hash do estilo).
- Novo: `src/core/cache.ts` — store (memória → Redis).
- Infra (v2 Redis): `infra/terraform/elasticache.tf` (ElastiCache Redis na VPC privada).
