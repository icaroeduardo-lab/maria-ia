import Stripe from "stripe";
import type { FastifyInstance } from "fastify";
import { prisma } from "./db.js";
import { PLANOS } from "./orgs.js";

// Billing via Stripe. Sem STRIPE_SECRET_KEY roda em modo mock: o upgrade
// troca o plano direto no banco (útil em dev e até a DPERJ contratar).

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// price id por plano (configurar no dashboard do Stripe)
const PRECOS: Record<string, string | undefined> = {
  pro: process.env.STRIPE_PRICE_PRO,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};

export function stripeConfigurado(): boolean {
  return stripe !== null;
}

export async function aplicarPlano(orgId: string, plano: string): Promise<void> {
  if (!prisma) return;
  const limite = PLANOS[plano]?.limiteConversasMes ?? 0;
  await prisma.organization.update({
    where: { id: orgId },
    data: { plano, limiteConversasMes: limite },
  });
}

// Inicia o upgrade: com Stripe retorna URL de checkout; sem, aplica direto (mock).
export async function iniciarUpgrade(
  orgId: string,
  plano: string,
  urlRetorno: string
): Promise<{ checkoutUrl?: string; aplicadoDireto?: boolean }> {
  if (!PLANOS[plano]) throw new Error(`plano inválido: ${plano}`);

  if (!stripe) {
    await aplicarPlano(orgId, plano);
    return { aplicadoDireto: true };
  }

  const price = PRECOS[plano];
  if (!price) throw new Error(`STRIPE_PRICE_${plano.toUpperCase()} não configurado`);

  const org = await prisma!.organization.findUniqueOrThrow({ where: { id: orgId } });
  let customer = org.stripeCustomerId;
  if (!customer) {
    const criado = await stripe.customers.create({ name: org.name, metadata: { orgId } });
    customer = criado.id;
    await prisma!.organization.update({ where: { id: orgId }, data: { stripeCustomerId: customer } });
  }

  const session = await stripe.checkout.sessions.create({
    customer,
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    metadata: { orgId, plano },
    success_url: `${urlRetorno}?upgrade=ok`,
    cancel_url: `${urlRetorno}?upgrade=cancelado`,
  });

  return { checkoutUrl: session.url ?? undefined };
}

// Webhook do Stripe: aplica o plano quando o checkout conclui.
// rawBody necessário para verificar a assinatura.
export async function processarWebhookStripe(rawBody: Buffer, assinatura: string | undefined): Promise<void> {
  if (!stripe) return;
  const segredo = process.env.STRIPE_WEBHOOK_SECRET;

  let evento: Stripe.Event;
  if (segredo && assinatura) {
    evento = stripe.webhooks.constructEvent(rawBody, assinatura, segredo);
  } else {
    evento = JSON.parse(rawBody.toString()) as Stripe.Event; // dev sem segredo
  }

  if (evento.type === "checkout.session.completed") {
    const session = evento.data.object as Stripe.Checkout.Session;
    const { orgId, plano } = (session.metadata ?? {}) as { orgId?: string; plano?: string };
    if (orgId && plano) {
      await aplicarPlano(orgId, plano);
      console.log(`[billing] org ${orgId} → plano ${plano}`);
    }
  }
}

// Plugin isolado: parser de body cru SÓ neste escopo (assinatura exige bytes originais)
export async function stripeRoutes(app: FastifyInstance) {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.post("/webhook/stripe", async (req, reply) => {
    try {
      await processarWebhookStripe(req.body as Buffer, req.headers["stripe-signature"] as string | undefined);
      return { received: true };
    } catch (err) {
      console.error("[billing] webhook inválido:", err);
      return reply.code(400).send({ erro: "webhook inválido" });
    }
  });
}
