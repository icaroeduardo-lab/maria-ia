# WhatsApp — Token permanente (System User)

O token de acesso que vem na aba **Configuração da API** é **temporário (~24h)**.
Quando expira, os envios falham com `401 code 190` ou `403 #131005` e a Maria
para de responder (recebe e processa, mas não consegue mandar).

Para um token que **não expira**, use um **Usuário do Sistema** (System User) no
Meta Business. Passo a passo:

## 1. Criar o Usuário do Sistema
1. [business.facebook.com/settings](https://business.facebook.com/settings) → conta de negócios da DPERJ.
2. **Usuários → Usuários do sistema** → **Adicionar**.
3. Nome: ex. `maria-bot`. Função: **Administrador**. Criar.

## 2. Dar acesso ao app do WhatsApp
1. Com o usuário do sistema selecionado → **Adicionar ativos**.
2. Aba **Aplicativos** → marca o app **"Maria IA"** → ativa **Controle total** (Gerenciar app).
3. (Opcional, recomendado) Aba **Contas do WhatsApp** → marca a WABA → Controle total.
4. Salvar.

## 3. Gerar o token permanente
1. Ainda no usuário do sistema → **Gerar novo token**.
2. App: **Maria IA**.
3. **Validade: Nunca** (sem expiração).
4. Permissões — marcar:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. **Gerar token** → **copiar** (só aparece uma vez).

## 4. Aplicar no Railway
Manda o token pro responsável técnico, que roda:

```bash
railway variables -s maria-backend --set "WA_ACCESS_TOKEN=<token-permanente>"
```

(O serviço redeploy sozinho. Confere em `GET /health` → `whatsappToken: "ok"`.)

## Observações
- O token permanente **não expira**, mas pode ser **revogado** manualmente no
  mesmo painel se vazar. Trate como segredo.
- O número de teste (+1 ...) continua entregando só para **destinatários
  verificados** (máx 5) enquanto a conta não passa pela **Verificação de
  Negócio**. O token permanente resolve a expiração, não a restrição de país/BR.
- `GET /health` mostra a validade do token a qualquer momento; o servidor também
  loga um aviso no boot e a cada 6h se o token estiver morto.
