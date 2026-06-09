# Mapeamento do Fluxo — Maria IA

> Base: `fluxo.json` exportado da plataforma legada.
> Objetivo: guia para reimplementação em LangGraph + Bedrock.

---

## 1. Consentimento

| ID grupo | Tipo | Pergunta / Ação |
|---|---|---|
| Mensagem de saudação | `lgpdNode` | Aceite do Termo de Privacidade (link LGPD). Se recusar → encerra com mensagem e telefone 129 |

---

## 2. Saudação / Apresentação

| ID grupo | Tipo | Conteúdo |
|---|---|---|
| Mensagem de saudação | `textNode` | "Olá! Eu sou a **Maria**, assistente virtual da Defensoria Pública..." |
| Mensagem de saudação | `textNode` | "🔒 Lembrete: Nosso serviço é **gratuito**!" |
| Mensagem de saudação | `textNode` | "⚠️ Não caia em golpes!" |
| Mensagem de saudação | `mediaNode` | Sticker/imagem da Maria |

---

## 3. Menu / Triagem

| ID grupo | Tipo | Pergunta | Opções |
|---|---|---|---|
| Menu Inicial | `optionsNode` | "De qual atendimento você precisa?" | Questões Trabalhistas · INSS, Caixa e Federal · Outros Assuntos |
| Encaminha Mostra opções | `optionsNode` | "Qual atendimento você precisa?" | Abrir processo de pensão · Outros assuntos |

### Saídas do menu

| Opção | Destino |
|---|---|
| Questões Trabalhistas | Mensagem informativa + tag → encerra |
| INSS, Caixa e Federal | Mensagem informativa + tag → encerra |
| Outros Assuntos | Fluxo de identificação de usuário |

---

## 4. Mensagens Informativas (sem coleta)

| Grupo | Mensagem |
|---|---|
| Orientação Demanda Trabalhista | "A DPERJ não realiza atendimento em casos da Justiça do Trabalho. Procure o sindicato da sua categoria..." |
| Orientação Demanda Justiça Federal | "A DPERJ não realiza atendimento em casos da Justiça Federal. Procure a DPU em www.dpu.def.br..." |
| Encerramento (sem identificação) | "Infelizmente não será possível continuar... Ligue 129 de segunda a sexta, 9h às 18h." |
| Erro de atualização (3 variações) | "Não consegui atualizar seus dados por aqui. Vou te passar para uma pessoa da nossa equipe." |
| CEP não encontrado | "Não encontramos esse CEP. Por favor, confira o número e digite novamente." |
| Fora do RJ | "O atendimento da DPERJ é destinado aos moradores do Estado do RJ. Transferindo para atendimento humano." |
| Tentativa novamente | "Certo, vamos tentar novamente." |
| Iniciando cadastro | "Certo, vamos fazer o seu cadastro." |
| Cadastrado com sucesso | "Cadastrado com sucesso!" |
| Endereço atualizado | "Endereço atualizado com sucesso!" |

---

## 5. Dados Pessoais

| Nó | Tipo | Campo coletado | Pergunta |
|---|---|---|---|
| Identificar Usuário | `inputNode` | `CPF` | "Para iniciar o seu atendimento, por favor informe o seu CPF." |
| Verifica CPF | `optionsNode` | confirmação | "O seu CPF é {{CPF}}?" → Sim / Não |
| Cadastrar Pessoa | `inputNode` | `Nome` | "Por favor, digite o seu nome completo." |
| Nome | `optionsNode` | confirmação | "Confirme, por favor: o seu nome é {{Nome}}?" → Sim / Não |
| Nome social | `optionsNode` | confirmação | "Confirme, por favor: o seu nome é {{Nome social}}?" → Sim / Não |
| Novo grupo (cadastro) | `optionsNode` | confirmação | "Confira se o seu nome foi escrito corretamente: {{Nome}}" → Sim, está correto / Não, está errado |

### Lógica associada
- Se `Nome social` existe → confirmar com nome social; senão confirmar com `Nome`
- Contador de tentativas de identificação (`contador_pessoa`): máximo 2 → após 3 tentativas → CPF não encontrado
- CPF não encontrado → opções: **Encerrar Atendimento** / **Atendimento Online**

---

## 6. Dados Residenciais

| Nó | Tipo | Campo coletado | Pergunta |
|---|---|---|---|
| Cadastrar Endereço | `inputNode` | `CEP` | "Agora vou cadastrar seu endereço. Por favor, **digite o seu CEP**:" |
| (atualização) | `inputNode` | `CEP` | "Qual o seu CEP?" |
| Novo grupo | `optionsNode` | confirmação CEP | "Confirma se o seu CEP foi digitado corretamente: {{CEP}}" → Sim / Não |
| Lista de UFs | `dynamicOptionsNode` | `Estado` + `idUF` | "Em qual Estado você mora?" (lista dinâmica via API) |
| Lista de municípios | `dynamicOptionsNode` | `Cidade` + `idMunicipio` | "E em qual cidade você mora?" (lista dinâmica via API) |
| Lista de Bairros | `dynamicOptionsNode` | `Bairro` + `idBairro` | "Agora, escolha ou digite o nome do seu bairro:" (lista dinâmica via API) |
| Novo grupo | `inputNode` | `Logradouro` | "Qual é o seu endereço atual (rua, avenida, praça, etc.)?" |
| Novo grupo | `inputNode` | `Número do endereço` | "Qual o número do seu endereço?" |
| Novo grupo | `optionsNode` | tem complemento? | "O endereço tem algum complemento (apartamento, bloco, etc.)?" → Sim / Não |
| Novo grupo | `inputNode` | `Complemento do endereço` | "Qual o complemento do endereço?" |
| Confirma endereço | `optionsNode` | confirmação completa | "Confira se o seu endereço está correto: CEP / UF / Município / Logradouro / Bairro / Número / Complemento" → Sim / Não |
| Novo grupo | `optionsNode` | confirmação resumida | "Por favor, confirme se o seu endereço está correto: {{Logradouro}}, {{Bairro}}, {{Cidade}}" → Sim / Não |
| Novo grupo | `optionsNode` | confirmação bairro | "Confirme se o seu bairro está correto: {{Bairro}}" → Sim / Não |
| Novo grupo | `optionsNode` | confirmação logradouro | "Você ainda mora na {{Logradouro}}?" → Sim / Não |
| Novo grupo | `optionsNode` | confirmação número | "O número do seu endereço é {{Número do endereço}}?" → Sim / Não |

### Lógica associada
- CEP via API → preenche automaticamente: Estado, Cidade, Bairro, Logradouro, Número
- Se campo existe no retorno do CEP → confirmar com usuário; se não → coletar manualmente
- Contador de tentativas CEP (`contador_cep`): máximo 3 → após 3 → transfere para humano
- Após CEP: verificar existência de Estado → Cidade → Bairro → Logradouro → Número (em cascata)

---

## 7. Dados de Contato

### 7.1 Telefone

| Nó | Tipo | Campo coletado | Pergunta |
|---|---|---|---|
| Verifica dados Telefone | `conditionNode` | — | Verifica se `Telefone Alternativo` já existe no cadastro |
| Verifica dados Telefone | `optionsNode` | confirmação | "Esse é o seu telefone para contato: {{Telefone Alternativo}}?" → Sim / Não |
| Novo grupo | `optionsNode` | tem telefone? | "Você pode informar um telefone para contato?" → Sim / Não tenho |
| Novo grupo | `optionsNode` | tem telefone? | "Você tem um telefone para contato?" → Sim / Não |
| Novo grupo | `inputNode` | `Telefone Alternativo` | "Qual é o número de telefone com DDD?" (formato nacional) |
| Novo grupo | `inputNode` | `Telefone Alternativo` | "Qual é o seu telefone para contato, com DDD?" (formato nacional) |
| Novo grupo | `optionsNode` | confirmação telefone | "O telefone está correto? {{Telefone Alternativo}}?" → Sim / Não |
| Novo grupo | `optionsNode` | confirmação telefone | "Confira se o seu telefone foi digitado corretamente: {{Telefone Alternativo}}" → Sim / Não |
| Novo grupo | `optionsNode` | é WhatsApp? | "Este número é WhatsApp?" → Sim / Não |
| Novo grupo | `optionsNode` | é WhatsApp? | "Este número é WhatsApp?" → Sim / Não _(variação no fluxo de atualização)_ |

### 7.2 E-mail

| Nó | Tipo | Campo coletado | Pergunta |
|---|---|---|---|
| Verifica dados Email | `conditionNode` | — | Verifica se `Email` já existe no cadastro |
| Verifica dados Email | `optionsNode` | confirmação | "O seu e-mail ainda é {{Email}}?" → Sim / Não |
| Novo grupo | `inputNode` | `Email` | "Qual é o seu e-mail? Vamos usá-lo para enviar informações sobre o seu caso." |
| Novo grupo | `inputNode` | `Email` | "Agora vou cadastrar seu e-mail. Por favor, **digite o seu E-mail**:" |
| Novo grupo | `optionsNode` | confirmação | "Confira se o seu e-mail foi escrito corretamente: {{Email}}" → Sim / Não |
| Novo grupo | `optionsNode` | confirmação | "Confira se o seu e-mail foi escrito corretamente? {{Email}}" → Sim / Não |

### Lógica associada
- DDD verificado: `5521` (Rio capital), `5522` (Sul Fluminense), `5524` (Costa Verde) → permitido
- Outros DDDs → mensagem "atendimento destinado a moradores do RJ" → transfere para humano
- Variável `Possui WhatsApp`: `true` / `false`
- Variável `Possui Telefone`: `true` / `false`

---

## 8. Cadastro

| Nó | Tipo | Pergunta | Opções |
|---|---|---|---|
| Cadastro | `optionsNode` | "Você ainda não tem um cadastro. Para continuar, podemos fazer o seu cadastro agora?" | Sim / Não |

### Fluxo após cadastro
- **Sim** → coleta Nome → Telefone → Email → CEP/Endereço → API POST /pessoa
- **Não** → retorna para Identificar Usuário

---

## 9. APIs (Integrações Externas)

| Nome | Método | Endpoint | Dados enviados | Dados recebidos |
|---|---|---|---|---|
| Consultar Pessoa | GET | `/pessoa?cpf={{CPF}}` | — | Nome, nomeSocial, email, telefone, endereço completo, idPessoa, statusValidação |
| Cadastrar Pessoa (sem tel.) | POST | `/pessoa` | nome, cpf, email, endereço completo | idPessoa |
| Cadastrar Pessoa (com tel.) | POST | `/pessoa` | nome, cpf, email, telefone, inWhatsapp, endereço completo | idPessoa |
| Atualizar Email | PUT | `/pessoa` | idPessoa, email | — |
| Atualizar Telefone | PUT | `/pessoa` | idPessoa, telefone, inWhatsapp | — |
| Atualizar Telefone (com data) | PUT | `/pessoa` | idPessoa, telefone, inWhatsapp, dataIndicacaoWhatsapp | — |
| Atualizar Endereço | PUT | `/pessoa` | idPessoa, endereço completo | — |
| Consultar CEP | GET | `/cep/{{CEP}}` | — | uf, bairro, municipio, logradouro, numero, complemento, ids |
| Listar UFs | GET | `/uf` | — | lista de UFs (id, sigla) |
| Listar Municípios | GET | `/municipio/consultar?uf={{Estado}}` | — | lista de municípios (id, nome) |
| Listar Bairros | GET | `/bairro/consultar?idMunicipio={{idMunicipio}}` | — | lista de bairros (id, nome) |

---

## 10. Lógica / Condições

| Variável | Operador | Valor | Ação se verdadeiro |
|---|---|---|---|
| `Nome social` | exists | — | Confirmar com nome social em vez de nome |
| `Telefone Alternativo` | exists | — | Confirmar telefone existente |
| `Email` | exists | — | Confirmar email existente |
| `Endereço Completo` | exists | — | Confirmar endereço existente |
| `Estado` | exists | — | Pular coleta de estado |
| `Cidade` | exists | — | Pular coleta de cidade |
| `Bairro` | exists | — | Pular coleta de bairro |
| `Logradouro` | exists | — | Pular coleta de logradouro |
| `Número do endereço` | exists | — | Pular coleta de número |
| `contador_pessoa` | > 2 | — | Ir para "CPF não encontrado" |
| `contador_cep` | == 3 | — | Transferir para humano |
| `Cadastrar` | == `true` | — | Usar API POST (cadastro novo) |
| `AtualizaEndereço` | == `true` | — | Usar API PUT (atualização) |
| `Possui Telefone` | == `true` | — | Usar POST com telefone |
| `canal_atendimento` | exists | — | Ir para próximo fluxo |
| `Telefone` | startsWith `5521` | — | Permitir (Rio capital) |
| `Telefone` | startsWith `5522` | — | Permitir (Sul Fluminense) |
| `Telefone` | startsWith `5524` | — | Permitir (Costa Verde) |
| qualquer outro DDD | — | — | Mensagem fora do RJ → humano |

---

## 11. Variáveis do Estado

| Variável | Tipo | Origem |
|---|---|---|
| `CPF` | string | input usuário |
| `Nome` | string | API ou input |
| `Nome social` | string | API (opcional) |
| `Email` | string | API ou input |
| `Telefone Alternativo` | string | API ou input |
| `Possui WhatsApp` | boolean | input usuário |
| `Possui Telefone` | boolean | derivado |
| `CEP` | string | input usuário |
| `Estado` | string | API CEP ou lista UFs |
| `Cidade` | string | API CEP ou lista municípios |
| `Bairro` | string | API CEP ou lista bairros |
| `Logradouro` | string | API CEP ou input |
| `Número do endereço` | string | API CEP ou input |
| `Complemento do endereço` | string | input (opcional) |
| `Endereço Completo` | string | API (string formatada) |
| `idPessoa` | string | API |
| `idUF` | string | API |
| `idMunicipio` | string | API |
| `idBairro` | string | API |
| `Cadastrar` | boolean | lógica |
| `AtualizaEndereço` | boolean | lógica |
| `contador_pessoa` | number | lógica |
| `contador_cep` | number | lógica |
| `canal_atendimento` | string | lógica |
| `endereco_atualizado` | boolean | lógica |

---

## 12. Nodes LangGraph Propostos

Com base na categorização acima, o grafo será dividido nos seguintes nós:

```
__start__
    │
    ▼
[saudacao]          → Mensagem de apresentação da Maria
    │
    ▼
[lgpd]              → Coleta aceite LGPD
    │
    ▼
[menu]              → Triagem: Trabalhista / Federal / Outros
    │
    ▼
[informativo]       → Se Trabalhista ou Federal → mensagem + fim
    │
    ▼
[dados_pessoais]    → Coleta e confirma CPF + Nome
    │
    ▼
[identificacao]     → API consultar pessoa → existe? cadastrado? novo?
    │
    ├─ cadastro novo → [cadastro]
    │                      │
    │                      ▼
    │               [dados_contato]   → Telefone + WhatsApp + Email
    │                      │
    │                      ▼
    │               [dados_residenciais] → CEP → Estado → Cidade → Bairro → Logradouro → Número → Complemento
    │                      │
    │                      ▼
    │               [confirmacao_endereco]
    │                      │
    │                      ▼
    │               [api_cadastrar]
    │
    └─ cadastro existente → [verificar_dados]
                                │
                                ├─ [verificar_telefone]
                                ├─ [verificar_email]
                                └─ [verificar_endereco]
                                        │
                                        ▼
                                [api_atualizar]
                                        │
                                        ▼
                                [encaminhamento]
```
