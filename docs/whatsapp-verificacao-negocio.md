# WhatsApp — Verificação de Negócio (entregar para qualquer número BR)

Enquanto a conta está **não verificada**, o número de teste só entrega para até
**5 destinatários verificados** e pode bloquear o Brasil com o erro
`130497 "Business account is restricted from messaging users in this country"`.

Para atender o público geral (qualquer número, sem o limite de 5), é preciso:
1. **Verificação de Negócio** da DPERJ no Meta Business.
2. Registrar um **número de telefone próprio** (não o número de teste).

> Token permanente (System User) resolve a expiração de 24h, **não** a restrição
> de país. São coisas separadas. Ver `docs/whatsapp-token-permanente.md`.

## 1. Verificação de Negócio (Business Verification)
1. [business.facebook.com/settings](https://business.facebook.com/settings) → **Central de Segurança** (Security Center).
2. Iniciar **Verificação de Negócio**.
3. Enviar os dados/documentos da DPERJ:
   - Nome legal, **CNPJ**, endereço e telefone oficiais.
   - Documento comprobatório (cartão CNPJ / ato constitutivo) e comprovante com o
     telefone/endereço (conta de serviço, etc).
4. A Meta confirma por telefone/e-mail do domínio oficial e analisa (alguns dias).

## 2. Registrar o número oficial
> Não dá para usar o número de teste em produção. Use um número que a DPERJ
> controle e que **não** tenha WhatsApp (comum/normal) ativo — ou faça a migração.
1. **WhatsApp → Configuração da API → "De" → Adicionar número de telefone**.
2. Informar nome de exibição, categoria, e validar por **SMS/voz** (OTP).
3. Concluir a verificação do número.
4. Copiar o novo **Phone number ID** → `WA_PHONE_NUMBER_ID` no Railway.

## 3. Publicar o app + permissões
1. **Painel do app → Análise do app**: solicitar `whatsapp_business_messaging`
   (e `whatsapp_business_management`) em modo **Live**.
2. Com Business Verification aprovada + número oficial, o app sai do modo
   desenvolvimento e entrega para **qualquer** número (respeitando a janela de
   24h / templates).

## Limites de mensagem (tiers)
Mesmo verificado, há um **limite de iniciações/dia** que sobe com a qualidade:
1k → 10k → 100k → ilimitado. Conversas iniciadas pelo assistido (atendimento)
entram como **service** e geralmente não contam no limite de iniciação.

## Checklist
- [ ] Business Verification aprovada (Central de Segurança)
- [ ] Número oficial registrado + verificado (não o de teste)
- [ ] `WA_PHONE_NUMBER_ID` atualizado no Railway
- [ ] `whatsapp_business_messaging` aprovado em modo Live
- [ ] Teste: enviar "oi" de um número **não** cadastrado nos 5 → recebe resposta
