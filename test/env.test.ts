import { test } from "node:test";
import assert from "node:assert/strict";
import { env } from "../src/core/env.js";

test("defaults quando as envs não estão setadas", () => {
  delete process.env.AWS_REGION;
  delete process.env.PORT;
  delete process.env.BEDROCK_MODEL_ID;
  delete process.env.SELF_URL;
  delete process.env.PUBLIC_URL;
  assert.equal(env.awsRegion(), "us-east-1");
  assert.equal(env.port(), 3000);
  assert.equal(env.bedrockModelId(), "anthropic.claude-3-haiku-20240307-v1:0");
  assert.equal(env.selfUrl(), "http://localhost:3000");
  assert.equal(env.publicUrl(), "http://localhost:3000"); // cai no selfUrl
});

test("publicUrl usa PUBLIC_URL quando setada", () => {
  process.env.PUBLIC_URL = "https://maria.exemplo.gov.br";
  assert.equal(env.publicUrl(), "https://maria.exemplo.gov.br");
  delete process.env.PUBLIC_URL;
});

test("pdpjApiUrl remove barra final", () => {
  process.env.PDPJ_API_URL = "https://api.pdpj/api/v1/";
  assert.equal(env.pdpjApiUrl(), "https://api.pdpj/api/v1");
  delete process.env.PDPJ_API_URL;
});

test("port respeita override numérico", () => {
  process.env.PORT = "8080";
  assert.equal(env.port(), 8080);
  delete process.env.PORT;
});
