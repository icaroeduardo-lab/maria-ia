import { prisma } from "./db.js";

// Multi-tenant: resolução de organização e limites de plano.

export const ORG_PADRAO = "dperj";

export const PLANOS: Record<string, { limiteConversasMes: number; preco: string }> = {
  free:       { limiteConversasMes: 100,  preco: "R$ 0" },
  pro:        { limiteConversasMes: 2000, preco: "R$ 499/mês" },
  enterprise: { limiteConversasMes: 0,    preco: "sob consulta" }, // 0 = ilimitado
};

// Web: subdomínio (<slug>.mariachat.com.br) ou header X-Org-Slug; default dperj.
export async function orgPorRequisicao(host: string | undefined, headerSlug: string | undefined): Promise<string> {
  if (!prisma) return ORG_PADRAO;
  const slug = headerSlug?.trim() || subdominioDe(host);
  if (!slug) return ORG_PADRAO;
  const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
  return org?.id ?? ORG_PADRAO;
}

function subdominioDe(host?: string): string | null {
  if (!host) return null;
  const nome = host.split(":")[0];
  const partes = nome.split(".");
  // precisa de pelo menos sub.dominio.tld; ignora localhost/IPs
  if (partes.length < 3 || /^\d+$/.test(partes[0])) return null;
  const sub = partes[0];
  return ["www", "api", "app"].includes(sub) ? null : sub;
}

// WhatsApp: cada org tem seu número; o webhook traz metadata.phone_number_id.
export async function orgPorPhoneNumberId(phoneNumberId: string | undefined): Promise<string> {
  if (!prisma || !phoneNumberId) return ORG_PADRAO;
  const org = await prisma.organization.findUnique({
    where: { waPhoneNumberId: phoneNumberId },
    select: { id: true },
  });
  return org?.id ?? ORG_PADRAO;
}

export interface UsoMes {
  usadas: number;
  limite: number; // 0 = ilimitado
  excedido: boolean;
}

// Conversas iniciadas no mês corrente vs limite do plano da org.
export async function usoDoMes(orgId: string): Promise<UsoMes> {
  if (!prisma) return { usadas: 0, limite: 0, excedido: false };
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  const limite = org?.limiteConversasMes ?? 0;
  const inicioMes = new Date();
  inicioMes.setDate(1);
  inicioMes.setHours(0, 0, 0, 0);
  const usadas = await prisma.conversation.count({
    where: { orgId, startedAt: { gte: inicioMes } },
  });
  return { usadas, limite, excedido: limite > 0 && usadas >= limite };
}
