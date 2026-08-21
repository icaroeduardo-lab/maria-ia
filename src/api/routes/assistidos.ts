import type { FastifyInstance } from "fastify";
import { prisma } from "../../core/db.js";
import { gatewayVerdeGet, gatewayVerdePost } from "../../core/gateway-verde.js";

// Rotas de Assistido (cidadão) usadas PELO FLUXO — sem JWT, como os mocks.
// O nó `api` do builder faz POST com body = dadosColetados (que contém o cpf).
// Respostas no mesmo formato dos mocks antigos p/ as condições continuarem valendo.

export const so_digitos = (s?: string) => (s ?? "").replace(/\D/g, "");

// Shape crua do Gateway Verde (GET /api/assistido/{cpf}) — issue #108.
// dataNascimento adicionada (maria-ia#20260202): a API real SEMPRE devolveu
// esse campo (dd/MM/yyyy) — o comentário antigo dizendo que não vinha estava
// desatualizado/errado. Faltava aqui, e o PUT de atualização nunca reenviava
// a data por não ter de onde puxar, o que zerava a data de nascimento real
// da pessoa no Verde a cada correção de endereço/telefone/email.
interface AssistidoVerdeRaw {
  dados?: {
    idPessoa?: number;
    nome?: string;
    email?: string;
    dataNascimento?: string;
    enderecoDetalhado?: {
      logradouro?: string;
      numero?: string;
      bairro?: string;
      municipio?: string;
      uf?: string;
      cep?: string;
    };
    telefonesAssistido?: { numeroTelefone?: string }[];
  };
}

// Consulta o cadastro real no Verde; mapeia pro mesmo shape do model
// Assistido local, pra `dadosPublicos()` continuar funcionando igual.
// null = não encontrado/gateway fora — quem chama cai pro fallback local.
export async function consultarAssistidoVerde(cpf: string): Promise<Record<string, unknown> | null> {
  const resp = await gatewayVerdeGet<AssistidoVerdeRaw>(`/api/assistido/${cpf}`);
  const d = resp?.dados;
  if (!d?.nome) return null;
  const end = d.enderecoDetalhado ?? {};
  return {
    cpf,
    idPessoa: d.idPessoa ?? null,
    nome: d.nome,
    // dd/MM/yyyy, formato bruto do Verde — usado só como fallback interno
    // (atualizarAssistidoVerde) pra reenviar no PUT; dadosPublicos()/ficha
    // não exibe esse campo hoje (não era o foco desta correção).
    dataNascimento: d.dataNascimento ?? null,
    nomeMae: null,
    situacao: "regular",
    municipio: end.municipio ?? null,
    uf: end.uf ?? null,
    telefone: d.telefonesAssistido?.[0]?.numeroTelefone ?? null,
    email: d.email ?? null,
    cep: end.cep ?? null,
    bairro: end.bairro ?? null,
    logradouro: end.logradouro ?? null,
    numero: end.numero ?? null,
  };
}

// Verde exige dtNascimento em dd/MM/yyyy — Maria coleta em yyyy-MM-dd
// (tipoPergunta "data", validado assim no engine). Descoberto investigando
// por que NENHUM cadastro desta sessão chegava no Verde de verdade: o
// gateway sempre devolvia "Parâmetro inválido" genérico (corrigido em
// GatewayConsultaApiVerde#43 pra expor o erro real) — aí sim apareceu
// "Formato de data inválido... Use dd/MM/yyyy" (maria-ia#20260202).
function paraDataVerde(isoYyyyMmDd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoYyyyMmDd);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : isoYyyyMmDd;
}

// Payload de cadastro do Verde (POST api/assistido) — issue maria-ia#117,
// gateway#31. Campos que a Maria não coleta hoje (nomeSocial) vão vazios: o
// Verde exige os campos presentes no JSON (não aceita ausentes — validação
// automática do ApiController do gateway). String vazia passa pra a
// maioria, MAS dtNascimento vazia OU email vazio dão 400 (confirmado contra
// o Verde real, 2026-08-04 — email exige formato válido, não aceita "")
// — ver checagem em cadastrarAssistidoVerde antes de chamar isso. numero:
// "SN" quando o assistido não tem número (card 2026-07-31, fluxo pergunta e
// converte "0" digitado pra "SN").
function montarPayloadAssistidoVerde(cpf: string, campos: Record<string, string>) {
  return {
    nome: campos.nome ?? "",
    nomeSocial: "",
    cpf,
    endereco: {
      logradouro: campos.logradouro ?? "",
      numero: campos.numero ?? "",
      complemento: campos.complemento ?? "",
      cep: campos.cep ?? "",
      bairro: campos.bairro ?? "",
      municipio: campos.municipio ?? "",
      uf: campos.uf ?? "",
    },
    telefones: campos.telefone
      ? [
          {
            id: 0,
            numeroTelefone: campos.telefone,
            observacao: "",
            inWhatsapp: campos.usaWhatsapp === "true",
            tipo: "celular",
            ramal: "",
            dataIndicacaoWhatsapp: "",
          },
        ]
      : [],
    email: campos.email ?? "",
    dtNascimento: campos.dataNascimento ? paraDataVerde(campos.dataNascimento) : "",
  };
}

// null = gateway fora/CPF rejeitado — quem chama cai pro fallback local.
// dtNascimento vazia OU email vazio dão 400 no Verde real (confirmado
// 2026-08-04, ver montarPayloadAssistidoVerde) — se não foram coletados,
// nem tenta, evita round-trip que sabe que vai falhar.
async function cadastrarAssistidoVerde(cpf: string, campos: Record<string, string>): Promise<boolean> {
  if (!campos.dataNascimento || !campos.email) return false;
  const resp = await gatewayVerdePost("/api/assistido", montarPayloadAssistidoVerde(cpf, campos));
  return resp.ok;
}

// PUT do Verde só aceita endereco/telefone/email (não tem campo "nome" —
// confirmado no Swagger, gateway#31). Se só nome mudou, não há o que
// atualizar lá — quem chama decide se ainda assim quer persistir local.
// telefone.numeroTelefone E email vazios dão 400 (testado em homologação,
// os dois isoladamente) — o Verde exige os dois preenchidos mesmo
// corrigindo só endereço (issue #187: fluxo novo pergunta 1 campo por vez,
// então quase nunca vêm juntos). SEMPRE busca o cadastro atual no Verde
// antes de montar o payload, pra completar telefone/email faltando.
//
// LIMITAÇÃO CONHECIDA DO VERDE (não corrigível do nosso lado, achado
// 2026-08-05): esse PUT some com a dataNascimento da pessoa mesmo
// corrigindo só endereço/telefone/email — tentamos reenviar `dtNascimento`
// no payload (gateway#44) e o Verde respondeu "Propriedade não
// reconhecida: 'dtNascimento'" (400), ou seja, esse endpoint nem aceita
// esse campo pra preservar. Reportar pro time do Verde/DPERJ — fora do
// nosso controle consertar por aqui.
async function atualizarAssistidoVerde(cpf: string, campos: Record<string, string>): Promise<boolean> {
  const relevante =
    campos.logradouro ||
    campos.numero ||
    campos.cep ||
    campos.bairro ||
    campos.municipio ||
    campos.uf ||
    campos.telefone ||
    campos.email;
  if (!relevante) return false;

  const atual = await consultarAssistidoVerde(cpf);
  const telefone = campos.telefone || ((atual?.telefone as string | null) ?? undefined);
  const email = campos.email || ((atual?.email as string | null) ?? undefined);
  if (!telefone || !email) return false; // Verde exige os dois preenchidos mesmo corrigindo só endereço

  const payload = {
    endereco: {
      logradouro: campos.logradouro ?? "",
      numero: campos.numero ?? "",
      complemento: "",
      cep: campos.cep ?? "",
      bairro: campos.bairro ?? "",
      municipio: campos.municipio ?? "",
      uf: campos.uf ?? "",
    },
    telefone: {
      id: 0,
      numeroTelefone: telefone,
      observacao: "",
      inWhatsapp: true,
      tipo: "celular",
      ramal: "",
      dataIndicacaoWhatsapp: "",
    },
    email,
  };
  const resp = await gatewayVerdePost(`/api/assistido/${cpf}`, payload, "PUT");
  if (!resp.ok) console.log(`[assistidos] atualizar: PUT no Verde falhou, status=${resp.status}`);
  return resp.ok;
}

// Shape crua do Gateway Verde (GET /api/casos/{cpf}) — issue maria-ia#110.
// Já filtrado a status "aberto" no gateway (CasosService); nomes de campo
// preservados exatamente como o Verde devolve (issue #20 do gateway).
interface CasoVerdeRaw {
  id?: number;
  status?: string;
  tipoCaso?: string;
  assunto?: { id?: number; nome?: string };
  numeroProcesso?: string | null;
  dataAtualizacao?: string;
  orgaosAssociados?: { id?: number; nome?: string; responsavel?: boolean }[];
  andamentos?: { titulo?: string; descricao?: string; data?: string }[];
}
interface CasosVerdeRaw {
  dados?: CasoVerdeRaw[];
}

interface CasoEnxuto {
  id: number | string;
  status: string;
  tipoCaso: string;
  assunto: { id: number; nome: string } | null;
  numeroProcesso: string | null;
  dataAtualizacao: string | null;
  orgaosAssociados: { id: number; nome: string; responsavel: boolean }[];
  andamentos: { titulo: string; descricao: string; data: string }[];
}

// null = gateway fora/CPF não encontrado — quem chama cai pro fallback local.
export async function consultarCasosVerde(cpf: string): Promise<CasoEnxuto[] | null> {
  const resp = await gatewayVerdeGet<CasosVerdeRaw>(`/api/casos/${cpf}`);
  const lista = resp?.dados;
  if (!lista) return null;
  return lista.map((c) => ({
    id: c.id ?? 0,
    status: c.status ?? "aberto",
    tipoCaso: c.tipoCaso ?? "",
    assunto: c.assunto?.nome ? { id: c.assunto.id ?? 0, nome: c.assunto.nome } : null,
    numeroProcesso: c.numeroProcesso ?? null,
    dataAtualizacao: c.dataAtualizacao ?? null,
    // enderecos/horarios de orgaosAssociados nunca são exibidos — descartados
    // aqui pra não carregar/persistir dado que não será usado (LGPD, minimização).
    orgaosAssociados: (c.orgaosAssociados ?? []).map((o) => ({
      id: o.id ?? 0,
      nome: o.nome ?? "",
      responsavel: !!o.responsavel,
    })),
    andamentos: (c.andamentos ?? []).map((a) => ({
      titulo: a.titulo ?? "",
      descricao: a.descricao ?? "",
      data: a.data ?? "",
    })),
  }));
}

// campos do Assistido que vêm de dadosColetados no cadastro/atualização
const CAMPOS = [
  "nome",
  "dataNascimento",
  "nomeMae",
  "situacao",
  "municipio",
  "uf",
  "telefone",
  "email",
  "cep",
  "bairro",
  "logradouro",
  "numero",
  "complemento",
  "usaWhatsapp",
] as const;

// Campos de CAMPOS que existem só pra montar o payload do Verde (flag de
// submissão), sem coluna equivalente no model Assistido — espalhar ...campos
// direto num db.assistido.create/update com um desses dentro derruba com
// PrismaClientValidationError (unknown argument), engolido silenciosamente
// pelo catch do node "api" no engine (usuário via "cadastro realizado" sem
// ter sido realizado — achado no teste manual, 2026-08-03, card a criar).
const CAMPOS_SO_VERDE = new Set<string>(["usaWhatsapp"]);

function paraBanco(campos: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(campos).filter(([k]) => !CAMPOS_SO_VERDE.has(k)));
}

function extrairCampos(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of CAMPOS) {
    const v = body[c];
    if (typeof v === "string" && v.trim()) out[c] = v.trim();
  }
  return out;
}

// remove campos internos da resposta exposta ao fluxo
function dadosPublicos(a: Record<string, unknown>) {
  const { id, createdAt, updatedAt, ...resto } = a;
  void id;
  void createdAt;
  void updatedAt;
  return resto;
}

export interface ResultadoAtualizacaoAssistido {
  sucesso: boolean;
  erro?: string;
  dados?: Record<string, unknown>;
}

// Atualização parcial de assistido (Verde primeiro, fallback local) —
// extraída do handler de /api/assistidos/atualizar pra ser reaproveitada
// também pela rota da Tykhe (src/api/routes/tykhe/), sem duplicar a lógica
// de negócio nem o comportamento (mesmas funções: atualizarAssistidoVerde,
// paraBanco, dadosPublicos). Diferente do handler original, não assume
// `prisma` não-nulo — quem tem o guard 503 é a rota interna (preHandler),
// a rota da Tykhe não tem esse guard e precisa de um fallback seguro.
export async function atualizarCampoAssistido(
  cpf: string,
  campos: Record<string, string>
): Promise<ResultadoAtualizacaoAssistido> {
  const verde = await atualizarAssistidoVerde(cpf, campos);
  if (verde) {
    console.log(`[assistidos] atualizar (Verde): CPF ${cpf} → campos: ${Object.keys(campos).join(", ")}`);
    return { sucesso: true, dados: { cpf, ...campos } };
  }

  if (!prisma) return { sucesso: false, erro: "assistido não encontrado" };

  const existe = await prisma.assistido.findUnique({ where: { cpf } });
  if (!existe) return { sucesso: false, erro: "assistido não encontrado" };

  const a = await prisma.assistido.update({ where: { cpf }, data: paraBanco(campos) });
  console.log(
    `[assistidos] atualizar (local): CPF ${cpf} → campos: ${Object.keys(campos).join(", ") || "(nenhum)"}`
  );
  return { sucesso: true, dados: dadosPublicos(a as unknown as Record<string, unknown>) };
}

export async function assistidosFlowRoutes(app: FastifyInstance) {
  // sem banco: rotas continuam registradas (conjunto determinístico — o guard
  // do openapi depende disso), mas todas respondem 503 via preHandler
  if (!prisma) {
    app.addHook("preHandler", async (_req, reply) => reply.code(503).send({ erro: "banco não configurado" }));
  }
  const db = prisma!; // preHandler acima garante que handler não roda sem banco

  // POST /api/assistidos/consultar — { cpf } → { encontrado, situacao, dados }
  // Tenta o Gateway Verde (cadastro real) primeiro; cai pro fallback local
  // (tabela Assistido — dados de teste/seed, ou quem se cadastrou pelo bot
  // sem constar no Verde) se não encontrar ou o gateway estiver fora (#108).
  app.post("/api/assistidos/consultar", async (req) => {
    const cpf = so_digitos((req.body as { cpf?: string })?.cpf);
    if (cpf.length !== 11) {
      console.log(`[assistidos] consultar: CPF inválido "${cpf}"`);
      return { encontrado: false, situacao: "formato_invalido", dados: null };
    }

    const verde = await consultarAssistidoVerde(cpf);
    if (verde) {
      console.log(`[assistidos] consultar: CPF ${cpf} → encontrado (Verde)`);
      return { encontrado: true, situacao: "regular", dados: verde };
    }

    const a = await db.assistido.findUnique({ where: { cpf } });
    console.log(`[assistidos] consultar: CPF ${cpf} → ${a ? "encontrado (local)" : "não cadastrado"}`);
    return {
      encontrado: !!a,
      situacao: a ? a.situacao : "nao_cadastrado",
      dados: a ? dadosPublicos(a as unknown as Record<string, unknown>) : null,
    };
  });

  // POST /api/assistidos/cadastrar — { cpf, nome, ... } → { sucesso, protocolo, dados }
  // Tenta cadastrar no Verde primeiro (POST api/assistido, issue maria-ia#117,
  // gateway#31 — cadastro real na Defensoria); cai pro fallback local se o
  // gateway estiver fora. Não checa "já existe" no Verde antes de tentar —
  // o Verde responde 422 nesse caso, tratado como falha (cai pro fallback,
  // que aí sim confere duplicidade local).
  app.post("/api/assistidos/cadastrar", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cpf = so_digitos(body.cpf as string);
    if (cpf.length !== 11) return reply.code(400).send({ sucesso: false, erro: "cpf inválido" });

    const campos = extrairCampos(body);
    if (!campos.nome) return reply.code(400).send({ sucesso: false, erro: "nome obrigatório" });

    const protocolo = `CAD-${new Date().getFullYear()}-${Math.floor(Math.random() * 90000 + 10000)}`;

    const verde = await cadastrarAssistidoVerde(cpf, campos);
    if (verde) {
      console.log(`[assistidos] cadastrar (Verde): CPF ${cpf} → ok — ${protocolo}`);
      return { sucesso: true, protocolo, dados: { cpf, ...campos } };
    }

    const existe = await db.assistido.findUnique({ where: { cpf } });
    if (existe) {
      console.log(`[assistidos] cadastrar (local): CPF ${cpf} já existe`);
      return {
        sucesso: false,
        jaExiste: true,
        dados: dadosPublicos(existe as unknown as Record<string, unknown>),
      };
    }

    const a = await db.assistido.create({ data: { cpf, nome: campos.nome, ...paraBanco(campos) } });
    console.log(`[assistidos] cadastrar (local): CPF ${cpf} criado — ${protocolo}`);
    return { sucesso: true, protocolo, dados: dadosPublicos(a as unknown as Record<string, unknown>) };
  });

  // POST /api/casos/consultar — { cpf, pagina_marcador? } → { tem_casos, casos:[...], lista, temMais }
  // Tenta o Gateway Verde primeiro (casos abertos de verdade, vinculados ao
  // processo quando houver); cai pro fallback local (tabela Caso — dados de
  // teste) se não encontrar ou o gateway estiver fora (issue maria-ia#110,
  // correção do fluxo — antes o assistido escolhia processo livremente, o
  // certo é partir do caso aberto na Defensoria).
  //
  // Paginação de 10 em 10 (pedido do usuário 2026-08-05, card #20260202):
  // visto CPF de teste com 80 casos abertos — lista inteira numa mensagem só
  // estourava o limite prático de mensagem (WhatsApp ~4096 chars) e virava
  // uma parede de texto ilegível. O motor de fluxo não tem contador/soma
  // nativo (só concatenação de string via {{}}), então a "página atual" é
  // codificada como o COMPRIMENTO de uma string marcadora que o fluxo só
  // sabe crescer (pagina_marcador = pagina_marcador + "X" a cada "mais") —
  // mesmo truque de combo_pendencias (string em vez de lógica nativa).
  // `casos` continua sempre completo (a seleção por índice em /casos/detalhe
  // precisa do array inteiro) — só `lista` (o texto mostrado) é fatiada.
  app.post("/api/casos/consultar", async (req) => {
    // nome do body TEM que bater com o chave usado no camposCorpo do node de
    // fluxo (casos_pagina_marcador) — achado ao vivo, 2026-08-05: o node
    // mandava certo, mas o destructure aqui lia "pagina_marcador" (nome
    // diferente), então o valor nunca chegava e a paginação sempre voltava
    // pra página 1 em silêncio.
    const { cpf: cpfRaw, casos_pagina_marcador: pagina_marcador } = (req.body ?? {}) as {
      cpf?: string;
      casos_pagina_marcador?: string;
    };
    const cpf = so_digitos(cpfRaw);

    let enxutos: CasoEnxuto[];
    const verde = cpf.length === 11 ? await consultarCasosVerde(cpf) : null;
    if (verde) {
      enxutos = verde;
      console.log(`[casos] consultar (Verde): CPF ${cpf} → ${enxutos.length} caso(s) aberto(s)`);
    } else {
      const assistido = cpf.length === 11 ? await db.assistido.findUnique({ where: { cpf } }) : null;
      const casos = assistido
        ? await db.caso.findMany({
            where: { assistidoId: assistido.id, status: "aberto" },
            orderBy: { criadoEm: "desc" },
          })
        : [];
      enxutos = casos.map((c) => ({
        id: c.id,
        status: c.status,
        tipoCaso: c.tipo,
        assunto: { id: 0, nome: c.tipo },
        numeroProcesso: null,
        dataAtualizacao: c.criadoEm.toLocaleDateString("pt-BR"),
        orgaosAssociados: [],
        andamentos: [],
      }));
      console.log(`[casos] consultar (local): CPF ${cpf} → ${enxutos.length} caso(s) aberto(s)`);
    }

    const TAMANHO_PAGINA = 10;
    const pagina = (pagina_marcador?.length ?? 0) + 1;
    const inicio = (pagina - 1) * TAMANHO_PAGINA;
    const pageItems = enxutos.slice(inicio, inicio + TAMANHO_PAGINA);
    const temMais = inicio + TAMANHO_PAGINA < enxutos.length;

    const lista = pageItems.length
      ? pageItems
          .map((c, i) => `${inicio + i + 1}. ${c.assunto?.nome ?? c.tipoCaso} (${c.dataAtualizacao ?? "-"})`)
          .join("\n") + (temMais ? "\n\nDigite *0* pra ver mais opções." : "")
      : "Não há mais casos pra mostrar.";
    return { tem_casos: enxutos.length > 0, casos: enxutos, lista, temMais };
  });

  // POST /api/casos/detalhe — { caso_sel, casos? } → detalhe de 1 caso
  // caso_sel pode ser o id completo OU o índice (1, 2, ...) da lista retornada
  // por /api/casos/consultar. Resolve direto do JSON que o fluxo já carrega
  // (mesmo padrão de agendamentos/detalhe) — zero chamada nova ao Verde pra
  // relistar. Só dispara UMA chamada nova, condicional: se o caso tiver
  // numeroProcesso, busca o status judicial (/api/processo/{numero}, já
  // real) e junta ao lado do histórico administrativo do caso — são dados
  // complementares (Defensoria x Judiciário), não uma confirmação.
  app.post("/api/casos/detalhe", async (req) => {
    const body = (req.body ?? {}) as { caso_sel?: string; casos?: string };
    const sel = String(body.caso_sel ?? "").trim();

    let lista: CasoEnxuto[] = [];
    try {
      lista = JSON.parse(body.casos ?? "{}")?.casos ?? [];
    } catch {
      /* segue vazio */
    }

    const idx = /^\d{1,2}$/.exec(sel);
    const caso = idx ? lista[Number(sel) - 1] : lista.find((c) => String(c.id) === sel);

    if (!caso) {
      console.log(`[casos] detalhe: "${sel}" não encontrado`);
      return { encontrado: false };
    }

    // só o andamento mais recente (não o histórico completo) — mantém a
    // estrutura de objeto, não achata em string.
    const andamentos = caso.andamentos.slice(0, 1);

    let processo: unknown = null;
    if (caso.numeroProcesso) {
      processo = await gatewayVerdeGet<unknown>(`/api/processo/${caso.numeroProcesso}`);
    }

    console.log(`[casos] detalhe: ${caso.id} (${caso.tipoCaso}) — processo=${processo ? "sim" : "não"}`);
    return {
      encontrado: true,
      id: caso.id,
      status: caso.status,
      tipoCaso: caso.tipoCaso,
      assunto: caso.assunto,
      orgaosAssociados: caso.orgaosAssociados,
      andamentos,
      numeroProcesso: caso.numeroProcesso,
      processo,
      // flag auxiliar pro fluxo rotear (condicao só faz match exato de label;
      // igual combo_pendencias — engine não tem truthy/if nativo em template)
      temProcesso: processo ? "true" : "false",
    };
  });

  // POST /api/assistidos/atualizar — { cpf, ...campos } → { sucesso, dados }
  // Tenta atualizar no Verde primeiro (PUT api/assistido/{cpf}, issue
  // maria-ia#117, gateway#31); cai pro fallback local se o gateway estiver
  // fora ou se os campos alterados forem só os que o Verde não aceita
  // (ex: só "nome" — PUT do Verde não tem esse campo).
  app.post("/api/assistidos/atualizar", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cpf = so_digitos(body.cpf as string);
    if (cpf.length !== 11) return reply.code(400).send({ sucesso: false, erro: "cpf inválido" });

    const campos = extrairCampos(body);
    const resultado = await atualizarCampoAssistido(cpf, campos);
    if (!resultado.sucesso) return reply.code(404).send(resultado);
    return resultado;
  });

  // POST /api/assistidos/campo-preenchido { valor? } → { preenchido }
  // Pedido do usuário 2026-08-11: gate genérico "esse campo tem valor?" —
  // endpoint dedicado em vez de condicao com label vazio (evita a
  // ambiguidade de match documentada nos outros gates de elegibilidade,
  // onde edge sem label e edge com label "" colidem no fallback do engine).
  // Usado no gate de UF≠RJ: se a ficha tem UF de verdade (não vazia), é
  // prova de outro estado — pula direto pro transbordo humano em vez de
  // perguntar "mora no RJ?" de novo.
  app.post("/api/assistidos/campo-preenchido", async (req) => {
    const valor = ((req.body as { valor?: string } | null)?.valor ?? "").trim();
    return { preenchido: !!valor };
  });
}
