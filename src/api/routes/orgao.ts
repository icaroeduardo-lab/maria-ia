import type { FastifyInstance } from "fastify";
import { gatewayVerdeGet } from "../../core/verde-direto.js";

// Rota de Órgão usada PELO FLUXO (cards Coilab #20260146/#20260147, issue
// gateway#39) — decide como conduzir a escolha de unidade/horário do
// "primeiro atendimento" pra um assunto, deixando o MÍNIMO de lógica pro
// fluxo (ele só executa perguntas condicionadas pelas flags abaixo).
//
// Reescrita completa (2026-08): a lógica antiga (auto-escolher "o melhor
// órgão", priorizando agendamento sobre encaminhamento e devolvendo só a
// 1ª vaga) foi DESCARTADA — regra de negócio nova definida com o usuário.
// Testado ao vivo contra homologação (CPF 17218415717/idPessoa 2973942,
// idAssunto 6371): o Verde pode devolver a MESMA unidade (mesmo `id`) duas
// vezes na lista — uma entrada "Agendamento Presencial", outra "Agendamento
// Remoto" (remoto normalmente sem `enderecos`) — são registros
// independentes por tipo, tratados como tal aqui. `vagasDisponiveis.
// vagasDisponiveis` pode vir vazio (unidade existe mas sem horário livre
// agora); entrada com vaga vazia é ignorada como se a unidade/tipo não
// existisse pra esta decisão.
//
// Regra de negócio:
// 1. Agrupa por (id, tipoAtendimento), descarta entradas sem vaga.
// 2. Separa em grupo presencial e grupo remoto (uma unidade pode estar nos
//    dois ao mesmo tempo).
// 3. Só pergunta remoto-vs-presencial se os DOIS grupos tiverem vaga; se só
//    um grupo tem vaga, assume ele direto (tipoDefault); se nenhum tem
//    vaga, `semVagaDisponivel: true` (fluxo decide o handoff).
// 4. Ramo presencial: >1 unidade → fluxo pergunta qual (lista embutida,
//    cada unidade já com suas vagas — evita 2ª chamada ao Verde); exatamente
//    1 → pula a pergunta, `vagasUnicaUnidade` já pronta.
// 5. Ramo remoto: >1 unidade → auto-escolhe a de MAIS horários (sem
//    perguntar); exatamente 1 → usa ela direto. `remoto.vagas` sempre já
//    resolvido.
//
// Decisão "vagas embutidas vs 2ª chamada" (pedida no card): (a) — cada
// unidade presencial já carrega sua lista de vagas no payload de
// /primeiro-atendimento (poucas unidades, poucos horários cada — payload
// não fica grande). Quando o assistido escolhe unidade por índice, o fluxo
// resolve contra o JSON já recebido via /api/orgao/unidade-detalhe (mesmo
// padrão de zero-chamada-nova-ao-Verde de agendamentos/vaga-detalhe —
// só índice, ver comentário na rota) — nunca precisa voltar ao Verde.
//
// Escolha de horário em 2 telas (ajuste pedido depois da 1ª versão): o
// fluxo não agrupa/computa nada, só lista e casa por índice — então `vagas`
// já vem PRÉ-AGRUPADA por data (`{ data, horarios: [{idIntervalo, hora}] }`)
// em vez de uma lista flat `{idIntervalo, data, hora}`. O fluxo mostra as
// datas primeiro, o assistido escolhe uma, só então mostra os horários
// daquela data. Mesmo formato agrupado nos 4 lugares que expõem vaga
// (presencial única unidade, presencial após escolher unidade via
// unidade-detalhe, remoto único, remoto auto-escolhido).

interface VagaVerdeRaw {
  idIntervalo?: number;
  data?: string;
  hora?: string;
}

interface OrgaoVerdeRaw {
  dados?: {
    id?: number;
    nome?: string;
    tipoAtendimento?: string;
    enderecos?: { bairro?: string; municipio?: string }[];
    vagasDisponiveis?: { vagasDisponiveis?: VagaVerdeRaw[] };
  }[];
}

interface VagaFlat {
  idIntervalo: number;
  data: string;
  hora: string;
}

interface HorarioEnxuto {
  idIntervalo: number;
  hora: string;
}

interface VagaAgrupada {
  data: string;
  horarios: HorarioEnxuto[];
  // Lista PRONTA (1 linha por horário real, numerada, sem slot vazio) —
  // mesmo padrão de resultado_agendamentos.lista/resultado_casos.lista.
  // Precomputada aqui (por data) porque o motor de fluxo não itera array em
  // {{...}}: os nodes de mensagem hoje usavam índice fixo hardcoded
  // (1..N), sobrando linha vazia quando tinha menos itens que o cap (bug
  // relatado 2026-08-14, screenshot com "4." e "5." em branco).
  listaHorarios: string;
}

interface UnidadeEnxuta {
  id: number;
  nome: string;
  bairro: string | null;
  municipio: string | null;
  vagas: VagaAgrupada[];
  // Lista PRONTA de datas (1 linha por data real, numerada) — par de `vagas`
  // pro mesmo motivo de `listaHorarios` acima.
  listaDatas: string;
}

// Fallback pra lista vazia — mesma convenção de resultado_casos.lista
// ("Não há mais casos pra mostrar.").
function formatarListaDatas(vagas: VagaAgrupada[]): string {
  if (vagas.length === 0) return "Nenhuma data disponível.";
  return vagas.map((v, i) => `${i + 1}. ${v.data}`).join("\n");
}

function formatarListaHorarios(horarios: HorarioEnxuto[]): string {
  if (horarios.length === 0) return "Nenhum horário disponível.";
  return horarios.map((h, i) => `${i + 1}. ${h.hora}`).join("\n");
}

// tipoAtendimento vem em texto livre do Verde ("Agendamento Presencial",
// "Agendamento Remoto") — normaliza por substring. Qualquer outra variação
// (nunca vista ao vivo até agora) é ignorada: não conta pra nenhum dos dois
// grupos, não trava a decisão.
function normalizarTipo(bruto: string): "presencial" | "remoto" | null {
  const t = bruto.toLowerCase();
  if (t.includes("remoto")) return "remoto";
  if (t.includes("presencial")) return "presencial";
  return null;
}

function mapVagasFlat(bruto?: VagaVerdeRaw[]): VagaFlat[] {
  return (bruto ?? [])
    .filter((v) => v.idIntervalo != null && v.data && v.hora)
    .map((v) => ({ idIntervalo: v.idIntervalo!, data: v.data!, hora: v.hora! }));
}

// Agrupa vagas flat (idIntervalo+data+hora) por data, preservando a ordem
// de chegada das datas — o fluxo lista datas primeiro (tela 1) e só depois
// os horários daquela data (tela 2), sem precisar agrupar/computar nada.
function agruparPorData(flat: VagaFlat[]): VagaAgrupada[] {
  const porData = new Map<string, HorarioEnxuto[]>();
  for (const v of flat) {
    const horarios = porData.get(v.data) ?? [];
    horarios.push({ idIntervalo: v.idIntervalo, hora: v.hora });
    porData.set(v.data, horarios);
  }
  return [...porData.entries()].map(([data, horarios]) => ({
    data,
    horarios,
    listaHorarios: formatarListaHorarios(horarios),
  }));
}

function totalHorarios(vagas: VagaAgrupada[]): number {
  return vagas.reduce((n, g) => n + g.horarios.length, 0);
}

// Agrupa entradas cruas do Verde por unidade dentro de UM tipo (presencial
// OU remoto), mesclando vagas de entradas duplicadas da mesma unidade+tipo
// (nunca visto ao vivo, mas o contrato do Verde não garante id único por
// tipo) e descartando quem não tem vaga nenhuma.
function agruparUnidades(entradas: NonNullable<OrgaoVerdeRaw["dados"]>): UnidadeEnxuta[] {
  const porId = new Map<
    number,
    { id: number; nome: string; bairro: string | null; municipio: string | null; vagasFlat: VagaFlat[] }
  >();
  for (const e of entradas) {
    if (e.id == null) continue;
    const vagasFlat = mapVagasFlat(e.vagasDisponiveis?.vagasDisponiveis);
    if (vagasFlat.length === 0) continue;
    const existente = porId.get(e.id);
    if (existente) {
      existente.vagasFlat.push(...vagasFlat);
    } else {
      porId.set(e.id, {
        id: e.id,
        nome: e.nome ?? "",
        bairro: e.enderecos?.[0]?.bairro ?? null,
        municipio: e.enderecos?.[0]?.municipio ?? null,
        vagasFlat,
      });
    }
  }
  return [...porId.values()].map((u) => {
    const vagas = agruparPorData(u.vagasFlat);
    return {
      id: u.id,
      nome: u.nome,
      bairro: u.bairro,
      municipio: u.municipio,
      vagas,
      listaDatas: formatarListaDatas(vagas),
    };
  });
}

interface OrgaoPrimeiroAtendimentoResp {
  perguntarTipo: boolean;
  tipoDefault: "presencial" | "remoto" | null;
  presencial: {
    temOpcao: boolean;
    perguntarUnidade: boolean;
    unidades: UnidadeEnxuta[];
    vagasUnicaUnidade: VagaAgrupada[];
    // Par de vagasUnicaUnidade — string pronta, mesmo motivo de
    // UnidadeEnxuta.listaDatas.
    listaDatasUnicaUnidade: string;
  };
  remoto: {
    temOpcao: boolean;
    unidadeEscolhida: { id: number; nome: string } | null;
    vagas: VagaAgrupada[];
    // Par de vagas — string pronta, mesmo motivo de UnidadeEnxuta.listaDatas.
    listaDatas: string;
  };
  semVagaDisponivel: boolean;
}

function respostaVazia(): OrgaoPrimeiroAtendimentoResp {
  return {
    perguntarTipo: false,
    tipoDefault: null,
    presencial: {
      temOpcao: false,
      perguntarUnidade: false,
      unidades: [],
      vagasUnicaUnidade: [],
      listaDatasUnicaUnidade: formatarListaDatas([]),
    },
    remoto: { temOpcao: false, unidadeEscolhida: null, vagas: [], listaDatas: formatarListaDatas([]) },
    semVagaDisponivel: true,
  };
}

export async function orgaoFlowRoutes(app: FastifyInstance) {
  // POST /api/orgao/primeiro-atendimento — { idPessoa, idAssunto, complemento? }
  // → ver OrgaoPrimeiroAtendimentoResp acima (flags prontas pro fluxo decidir
  // o mínimo: perguntar tipo?, perguntar unidade?, e listar horários).
  app.post("/api/orgao/primeiro-atendimento", async (req) => {
    const body = (req.body ?? {}) as {
      idPessoa?: string | number;
      idAssunto?: string | number;
      complemento?: string;
    };
    const idPessoa = Number(body.idPessoa);
    const idAssunto = Number(body.idAssunto);
    if (!idPessoa || !idAssunto) {
      console.log(`[orgao] primeiro-atendimento: idPessoa/idAssunto inválidos`);
      return respostaVazia();
    }

    const complemento = body.complemento ? `&complemento=${encodeURIComponent(body.complemento)}` : "";
    const resp = await gatewayVerdeGet<OrgaoVerdeRaw>(
      `/orgao/primeiro-atendimento?idPessoa=${idPessoa}&idAssunto=${idAssunto}${complemento}`
    );
    const lista = resp?.dados ?? [];

    const presenciais = agruparUnidades(
      lista.filter((e) => normalizarTipo(e.tipoAtendimento ?? "") === "presencial")
    );
    const remotos = agruparUnidades(
      lista.filter((e) => normalizarTipo(e.tipoAtendimento ?? "") === "remoto")
    );

    const temPresencial = presenciais.length > 0;
    const temRemoto = remotos.length > 0;
    const perguntarTipo = temPresencial && temRemoto;
    const tipoDefault: "presencial" | "remoto" | null = perguntarTipo
      ? null
      : temPresencial
        ? "presencial"
        : temRemoto
          ? "remoto"
          : null;

    // Remoto: nunca pergunta qual unidade — auto-escolhe a de mais horários
    // no total (soma de todos os dias, não número de dias distintos; empate
    // mantém a ordem de chegada do Verde).
    const remotoEscolhida = temRemoto
      ? remotos.reduce((melhor, atual) =>
          totalHorarios(atual.vagas) > totalHorarios(melhor.vagas) ? atual : melhor
        )
      : null;

    const vagasUnicaUnidade = presenciais.length === 1 ? presenciais[0].vagas : [];
    const vagasRemoto = remotoEscolhida?.vagas ?? [];

    const resposta: OrgaoPrimeiroAtendimentoResp = {
      perguntarTipo,
      tipoDefault,
      presencial: {
        temOpcao: temPresencial,
        perguntarUnidade: presenciais.length > 1,
        unidades: presenciais,
        vagasUnicaUnidade,
        listaDatasUnicaUnidade: formatarListaDatas(vagasUnicaUnidade),
      },
      remoto: {
        temOpcao: temRemoto,
        unidadeEscolhida: remotoEscolhida ? { id: remotoEscolhida.id, nome: remotoEscolhida.nome } : null,
        vagas: vagasRemoto,
        listaDatas: formatarListaDatas(vagasRemoto),
      },
      semVagaDisponivel: !temPresencial && !temRemoto,
    };

    console.log(
      `[orgao] primeiro-atendimento: idAssunto=${idAssunto} → presencial=${presenciais.length} remoto=${remotos.length} perguntarTipo=${perguntarTipo}`
    );
    return resposta;
  });

  // POST /api/orgao/unidade-detalhe — { unidade_sel, orgao_resultado } →
  // resolve a unidade PRESENCIAL escolhida (índice 1-based na lista que o
  // fluxo mostrou) contra o JSON que /primeiro-atendimento já devolveu —
  // orgao_resultado é essa resposta crua (mesma chave de dadosColetados,
  // sem wrapper extra). Só índice, sem fallback por `id` direto: `id` de
  // unidade no Verde é um inteiro puro (não um id tipo "MARIA-..." como em
  // agendamentos/detalhe) e pode colidir com a própria faixa de índice
  // (1-2 dígitos) — ambíguo, então segue o mesmo padrão de
  // agendamentos/vaga-detalhe (só índice). Zero chamada nova ao Verde: as
  // vagas de cada unidade já vieram embutidas na 1ª chamada.
  app.post("/api/orgao/unidade-detalhe", async (req) => {
    const body = (req.body ?? {}) as { unidade_sel?: string; orgao_resultado?: string };
    const sel = String(body.unidade_sel ?? "").trim();

    let unidades: UnidadeEnxuta[] = [];
    try {
      unidades = JSON.parse(body.orgao_resultado ?? "{}")?.presencial?.unidades ?? [];
    } catch {
      /* segue vazio */
    }

    const idx = /^\d{1,2}$/.exec(sel);
    const unidade = idx ? unidades[Number(sel) - 1] : undefined;

    if (!unidade) {
      console.log(`[orgao] unidade-detalhe: "${sel}" não encontrada`);
      return { encontrada: false };
    }
    console.log(`[orgao] unidade-detalhe: "${sel}" → unidade ${unidade.id}`);
    // listaDatas normalmente já vem no JSON (unidade.listaDatas, calculada
    // em /primeiro-atendimento) — recalcula como fallback defensivo se o
    // fluxo estiver com um orgao_resultado antigo em cache (sem o campo).
    return {
      encontrada: true,
      id: unidade.id,
      nome: unidade.nome,
      bairro: unidade.bairro,
      municipio: unidade.municipio,
      vagas: unidade.vagas,
      listaDatas: unidade.listaDatas ?? formatarListaDatas(unidade.vagas ?? []),
    };
  });
}
