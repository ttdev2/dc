import "dotenv/config";

const asBoolean = (value, fallback = false) => {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "sim", "on"].includes(String(value).toLowerCase());
};

const asList = (value) => {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const asNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const isConfigured = (value) => {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return !normalized.includes("coloque_") && !normalized.includes("_aqui");
};

export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    guildId: process.env.DISCORD_GUILD_ID,
    autoDeployCommands: asBoolean(process.env.AUTO_DEPLOY_COMMANDS, false),
  },
  misticPay: {
    clientId: process.env.MISTICPAY_CLIENT_ID,
    clientSecret: process.env.MISTICPAY_CLIENT_SECRET,
    baseUrl: process.env.MISTICPAY_BASE_URL || "https://api.misticpay.com/api",
    projectWebhookUrl: process.env.MISTICPAY_PROJECT_WEBHOOK_URL || undefined,
    defaultPayerName: process.env.MISTICPAY_DEFAULT_PAYER_NAME || "Cliente Discord",
    defaultPayerDocument: process.env.MISTICPAY_DEFAULT_PAYER_DOCUMENT || undefined,
  },
  auth: {
    userIds: asList(process.env.AUTHORIZED_USER_IDS),
    roleIds: asList(process.env.AUTHORIZED_ROLE_IDS),
    allowDiscordAdmins: asBoolean(process.env.ALLOW_DISCORD_ADMINS, false),
  },
  webhook: {
    enabled: asBoolean(process.env.WEBHOOK_SERVER_ENABLED, false),
    port: asNumber(process.env.WEBHOOK_PORT, 3000),
    secret: process.env.WEBHOOK_SECRET || undefined,
    channelId: process.env.DISCORD_WEBHOOK_CHANNEL_ID || undefined,
  },
};

export function assertRequiredConfig() {
  const missing = [];

  if (!isConfigured(config.discord.token)) missing.push("DISCORD_TOKEN");
  if (!isConfigured(config.discord.clientId)) missing.push("DISCORD_CLIENT_ID");
  if (!isConfigured(config.misticPay.clientId)) missing.push("MISTICPAY_CLIENT_ID");
  if (!isConfigured(config.misticPay.clientSecret)) missing.push("MISTICPAY_CLIENT_SECRET");

  if (missing.length) {
    throw new Error(`Variaveis de ambiente obrigatorias ausentes: ${missing.join(", ")}`);
  }
}

export function hasAuthorizationConfig() {
  return (
    config.auth.userIds.length > 0 ||
    config.auth.roleIds.length > 0 ||
    config.auth.allowDiscordAdmins
  );
}
