import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";

// Fila SQS FIFO entre a api (produz) e o worker (consome).
// MessageGroupId = número do WhatsApp → mensagens do mesmo cidadão processadas
// em ordem, nunca em paralelo. MessageDeduplicationId = id da mensagem da Meta
// → reentregas são descartadas nativamente pela fila FIFO.

import { env } from "./env.js";

const QUEUE_URL = () => env.sqsQueueUrl();

const client = new SQSClient({ region: env.awsRegion() });

// Payload que trafega na fila (uma mensagem recebida do WhatsApp) — mesmo
// shape de MensagemRecebida (channels/whatsapp.ts); mantido espelhado aqui
// porque o worker desserializa via JSON.parse(...) as MsgFila (sem import
// direto do tipo, para não acoplar queue.ts ao canal).
export interface MsgFila {
  id: string;
  from: string;
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
