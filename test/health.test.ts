import { test } from "node:test";
import assert from "node:assert/strict";
import { montarApp } from "../src/api/app.js";

// Regressão do #42: token do WhatsApp inválido NÃO pode derrubar a API
// (health 503 fazia o ALB ciclar as tasks em loop). 503 é só pra DB fora.

test("health responde 200 mesmo com token WhatsApp inválido", async () => {
  // token configurado mas inválido → Graph API recusa → verificarTokenWhatsApp() false
  process.env.WA_ACCESS_TOKEN = "token-invalido-de-teste";
  process.env.WA_PHONE_NUMBER_ID = "000000000000";

  const app = await montarApp();
  const res = await app.inject({ method: "GET", url: "/health" });
  await app.close();

  assert.equal(res.statusCode, 200, "token inválido não derruba a API");
  const corpo = res.json();
  assert.equal(corpo.whatsappToken, "invalido", "estado do token segue reportado no corpo");
  assert.equal(corpo.ok, true);
});
