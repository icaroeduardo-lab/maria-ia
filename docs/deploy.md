# Deploy — Maria Chat (WhatsApp online 24/7)

Objetivo: subir o backend (que roda o fluxo) numa URL pública HTTPS e ligar ao
WhatsApp via **número de teste da Meta**.

---

## 1. Host (recomendado: Railway)

O backend é um container Docker (`Dockerfile.backend`) + Postgres. Qualquer host
que rode Docker + Postgres serve. **Railway** é o mais simples (deploy do GitHub,
Postgres gerenciado, sem CLI):

1. railway.app → New Project → **Deploy from GitHub repo** → escolher `maria-ia`.
2. Em Settings do serviço: **Dockerfile Path** = `Dockerfile.backend`.
3. Add plugin **PostgreSQL** → ele cria a env `DATABASE_URL` (referenciar no serviço).
4. Definir as variáveis de ambiente (seção 3).
5. Deploy. O start roda `prisma migrate deploy` (cria as tabelas) e sobe o server na porta 3000.
6. Railway dá uma URL pública `https://<app>.up.railway.app`. **Essa é a base do webhook.**
7. Rodar o seed uma vez (Railway → shell do serviço): `pnpm seed`.

> Alternativas: **Fly.io** (CLI, `fly launch` usa o Dockerfile + `fly postgres`),
> **Render**, ou **VPS** com `docker compose up` (usa o `docker-compose.yml`; precisa configurar TLS no nginx).

### Banco no Supabase (opcional)
Pode usar o Postgres do Supabase em vez do banco do host:
1. Supabase → projeto → **Connect** → copiar a **Direct connection** (porta **5432**).
2. `DATABASE_URL=postgresql://postgres:<senha>@db.<ref>.supabase.co:5432/postgres`
3. Usar a conexão **direta (5432)**, NÃO o pooler (6543) — o pooler em modo transação
   quebra os prepared statements do Prisma. (Se precisar do pooler: `?pgbouncer=true` + `directUrl` no schema.)
4. O `start` roda `prisma migrate deploy` (tabelas do Prisma) e o `PostgresSaver.setup()`
   cria o schema `langgraph` automaticamente. Rodar `pnpm seed` uma vez.
5. Free tier pausa após inatividade (ok para teste; 24/7 real → plano pago).

---

## 2. WhatsApp — número de teste da Meta

1. developers.facebook.com → criar App (tipo **Business**) → adicionar produto **WhatsApp**.
2. Em **WhatsApp > API Setup**: já vem um **número de teste** grátis.
   - Copiar o **Phone number ID** → `WA_PHONE_NUMBER_ID`.
   - Copiar o **temporary access token** (24h) → `WA_ACCESS_TOKEN`.
     - Para 24/7 sem expirar: criar um **System User** (Business Settings) com token permanente.
   - Em "To": adicionar os números autorizados a receber (o número de teste só fala com números cadastrados).
3. **Webhook** (WhatsApp > Configuration):
   - Callback URL: `https://<seu-host>/webhook/whatsapp`
   - Verify token: o valor que você puser em `WA_WEBHOOK_VERIFY_TOKEN` (você inventa).
   - Clicar **Verify and Save** (a Meta chama o GET; nosso endpoint responde o challenge).
   - **Subscribe** ao campo **messages**.

---

## 3. Variáveis de ambiente (no host)

> **Postgres gerenciado (RDS/Supabase/etc.) exige SSL** — termine a URL com
> `?sslmode=require`. O checkpointer converte para `no-verify` internamente
> (SSL sem validar a CA, padrão para RDS sem bundle de certificado).

```
# Banco (o host gerenciado fornece) — com ?sslmode=require em RDS/Supabase
DATABASE_URL=postgresql://...?sslmode=require

# Própria URL pública (resolve nós de API com caminho relativo /api/...)
SELF_URL=https://<seu-host>

# JWT do painel admin (trocar!)
JWT_SECRET=<aleatório-forte>
SEED_ADMIN_PASSWORD=<senha-admin>

# WhatsApp (número de teste da Meta)
WA_PHONE_NUMBER_ID=
WA_ACCESS_TOKEN=
WA_WEBHOOK_VERIFY_TOKEN=<inventar; mesmo valor no painel da Meta>

# AWS (Bedrock classificação/IA, S3 ficha, Transcribe áudio)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=anthropic.claude-3-haiku-20240307-v1:0
BEDROCK_KB_ID=LF04FDVIYP
S3_BUCKET=maria-ia

# DPERJ (vazio = mock/protocolo local)
DPERJ_API_URL=
DPERJ_API_KEY=
```

---

## 4. Checklist pós-deploy

- [ ] `GET https://<host>/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=123` retorna `123`
- [ ] Webhook verificado e inscrito em **messages** na Meta
- [ ] Fluxo "Fluxo DPERJ Completo" está **ativo** (painel → Fluxos)
- [ ] Enviar "oi" do número autorizado → recebe a saudação da Maria
- [ ] Testar áudio (Transcribe) e a ficha (S3) num atendimento real

---

## Notas
- O número de teste só envia para números **autorizados** na Meta. Para público geral,
  é preciso um número próprio verificado + revisão do app pela Meta.
- A ficha e os áudios ficam no S3 e expiram em 1 dia (lifecycle). Garanta as credenciais AWS.
- Token temporário da Meta expira em 24h — use System User para token permanente.
