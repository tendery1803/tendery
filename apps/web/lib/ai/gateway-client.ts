import { AiGatewayClient } from "@tendery/integrations";

export function getAiGatewayClient(): AiGatewayClient {
  const baseUrl = process.env.AI_GATEWAY_BASE_URL;
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("AI_GATEWAY_BASE_URL / AI_GATEWAY_API_KEY не заданы");
  }
  return new AiGatewayClient({ baseUrl, apiKey });
}
