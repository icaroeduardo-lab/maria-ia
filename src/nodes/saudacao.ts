import { AIMessage } from "@langchain/core/messages";
import type { GraphState } from "../state.js";

const IMAGEM_MARIA = "https://maria-ia.s3.us-east-1.amazonaws.com/maria-ia.webp";

const TEXTO_SAUDACAO =
  "Olá! Eu sou a **Maria**, assistente virtual da Defensoria Pública. Estou aqui para te ajudar 😊\n\n" +
  "🔒 *Lembrete importante:* Nosso serviço é *gratuito!*\n\n" +
  "⚠️ *Não caia em golpes!*";

export async function saudacao(_state: GraphState) {
  return {
    messages: [
      new AIMessage({
        content: [
          { type: "image_url", image_url: { url: IMAGEM_MARIA } },
          { type: "text", text: TEXTO_SAUDACAO },
        ],
      }),
    ],
  };
}
