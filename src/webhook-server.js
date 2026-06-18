import express from "express";
import { EmbedBuilder } from "discord.js";

export function startWebhookServer({ client, config }) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.post("/webhooks/misticpay", async (request, response) => {
    if (config.webhook.secret && request.query.secret !== config.webhook.secret) {
      response.status(401).json({ error: "invalid secret" });
      return;
    }

    response.status(202).json({ ok: true });

    if (!config.webhook.channelId) return;

    try {
      const channel = await client.channels.fetch(config.webhook.channelId);
      if (!channel?.isTextBased()) return;

      const payload = request.body ?? {};
      const embed = buildWebhookEmbed(payload);
      await channel.send({ embeds: [embed] });
    } catch (error) {
      console.error("Falha ao publicar webhook no Discord:", error);
    }
  });

  const server = app.listen(config.webhook.port, () => {
    console.log(`Webhook server ouvindo na porta ${config.webhook.port}.`);
  });

  return server;
}

function buildWebhookEmbed(payload) {
  const type = payload.transactionType || payload.event || "MisticPay";
  const status = payload.status || payload.infraction?.status || payload.transaction?.status || "sem status";
  const value = payload.value ?? payload.infraction?.amount ?? payload.transaction?.value;
  const transactionId = payload.transactionId ?? payload.transaction?.transactionId ?? payload.transaction?.id;

  const embed = new EmbedBuilder()
    .setTitle(`Webhook ${type}`)
    .setColor(status === "COMPLETO" ? 0x2ecc71 : status === "FALHA" ? 0xe74c3c : 0xf1c40f)
    .setTimestamp(new Date());

  embed.addFields({ name: "Status", value: String(status), inline: true });

  if (transactionId) {
    embed.addFields({ name: "Transacao", value: String(transactionId), inline: true });
  }

  if (value !== undefined) {
    embed.addFields({ name: "Valor", value: formatBrl(Number(value)), inline: true });
  }

  if (payload.e2e) {
    embed.addFields({ name: "E2E", value: String(payload.e2e).slice(0, 1024) });
  }

  return embed;
}

function formatBrl(value) {
  if (!Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
}
