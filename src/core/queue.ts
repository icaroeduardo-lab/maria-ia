import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";

// Fila SQS FIFO única, compartilhada entre os canais (WhatsApp + Telegram),
// entre a api (produz) e o worker (consome).
// MessageGroupId = id da conversa no canal (wa_id ou chat_id) → mensagens do
// mesmo cidadão processadas em ordem, nunca em paralelo. MessageDeduplicationId
// = id da mensagem/update do provedor → reentregas descartadas nativamente
// pela fila FIFO.

import { env } from "./env.js";

const QUEUE_URL = () => env.sqsQueueUrl();

const client = new SQSClient({ region: env.awsRegion() });

// Payload que trafega na fila (uma mensagem recebida de qualquer canal) —
// mesmo shape de MensagemRecebida (channels/whatsapp.ts) e
// MensagemRecebidaTelegram (channels/telegram.ts); mantido espelhado aqui
// porque o worker desserializa via JSON.parse(...) as MsgFila (sem import
// direto do tipo, para não acoplar queue.ts aos canais). mediaId/mediaMimeType/
// mediaNomeOriginal são compartilhados entre os dois canais (foto/documento,
// issue #74) — cada canal preenche com o id de mídia do seu próprio provedor
// (media_id da Graph API ou file_id da Bot API).
// `canal` decide o dispatch no worker (../worker/worker.ts); ausente = trata
// como "whatsapp" (compat com mensagens enfileiradas antes do canal existir).
export interface MsgFila {
  id: string;
  from: string;
  canal?: "whatsapp" | "telegram";
  texto?: string;
  audioId?: string;
  mediaId?: string;
  mediaMimeType?: string;
  mediaNomeOriginal?: string;
}

export function filaConfigurada(): boolean {
  return QUEUE_URL() !== "";
}

export async function enfileirar(msg: MsgFila): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL(),
      MessageBody: JSON.stringify(msg),
      MessageGroupId: msg.from, // ordem por conversa
      MessageDeduplicationId: msg.id, // dedupe de reentrega da Meta
    })
  );
}

// Loop de consumo (long polling). Chama `handler` por mensagem; só apaga da
// fila em caso de sucesso (falha → reentrega e, após maxReceiveCount, vai à DLQ).
export async function consumir(handler: (msg: MsgFila) => Promise<void>): Promise<void> {
  console.log(`[worker] consumindo ${QUEUE_URL()}`);
  for (;;) {
    const res = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL(),
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
      })
    );
    for (const m of res.Messages ?? []) {
      try {
        await handler(JSON.parse(m.Body ?? "{}") as MsgFila);
        await client.send(
          new DeleteMessageCommand({ QueueUrl: QUEUE_URL(), ReceiptHandle: m.ReceiptHandle })
        );
      } catch (err) {
        console.error("[worker] falha ao processar mensagem (reentrega):", err);
        // não apaga → SQS reentrega; após maxReceiveCount vai para a DLQ
      }
    }
  }
}
