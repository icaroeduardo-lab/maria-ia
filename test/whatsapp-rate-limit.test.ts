import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Guard estático (card #20260122): o webhook precisa checar o rate limit
// DEPOIS do dedupe por message.id e ANTES de enfileirar/processar — senão
// mensagem excedente ainda dispara o grafo (custo de IA / flood na fila).

test("webhook checa rate limit entre o dedupe e o enfileiramento/processamento", () => {
  const src = readFileSync(new URL("../src/core/channels/whatsapp.ts", import.meta.url), "utf8");

  const iDedupe = src.indexOf("jaProcessado(msg.id)");
  const iLimite = src.indexOf("dentroDoLimite(msg.from)");
  const iFila = src.indexOf("filaConfigurada()");
  assert.ok(iDedupe > -1 && iLimite > -1 && iFila > -1, "trechos esperados não encontrados");
  assert.ok(iDedupe < iLimite, "dedupe por message.id deve rodar antes do rate limit");
  assert.ok(iLimite < iFila, "rate limit deve rodar antes de enfileirar/processar");

  assert.match(src, /avisarLimiteExcedido/, "excedente deve disparar aviso amigável, não silenciar");
});

test("aviso de rate limit não repete dentro da mesma janela (checa cache antes de enviar)", () => {
  const src = readFileSync(new URL("../src/core/channels/whatsapp.ts", import.meta.url), "utf8");
  const inicio = src.indexOf("async function avisarLimiteExcedido");
  const corpo = src.slice(inicio, src.indexOf("\n}\n", inicio));

  assert.match(corpo, /cacheGet.*chaveAviso/, "deve checar se já avisou nesta janela antes de enviar de novo");
  assert.match(corpo, /return;/, "deve sair cedo (sem reenviar) se já avisado");
});
