import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { config, assertRequiredConfig } from "./config.js";
import { deployCommands } from "./deploy-commands.js";
import { MisticPayClient, MisticPayError } from "./misticpay.js";
import { startWebhookServer } from "./webhook-server.js";

assertRequiredConfig();

const COLORS = {
  brand: 0x5865f2,
  success: 0x2ecc71,
  warning: 0xf1c40f,
  danger: 0xe74c3c,
  info: 0x3498db,
};

const WITHDRAW_CONFIRM_TTL_MS = 2 * 60 * 1000;
const CRYPTO_MIN_BRL = 20;
const CRYPTO_MAX_BRL = 3000;

const pendingWithdrawals = new Map();
let payerProfileCache;

const misticPay = new MisticPayClient(config.misticPay);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const ephemeralOptions = (enabled = true) => (enabled ? { flags: MessageFlags.Ephemeral } : {});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Bot conectado como ${readyClient.user.tag}.`);

  if (config.discord.autoDeployCommands) {
    const result = await deployCommands();
    console.log(`Comandos slash registrados automaticamente em ${result.scope}.`);
  }

  if (config.webhook.enabled) {
    startWebhookServer({ client, config });
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction);
    }
  } catch (error) {
    await replyWithError(interaction, error);
  }
});

setInterval(cleanupExpiredWithdrawals, 60_000).unref();

await client.login(config.discord.token);

async function handleCommand(interaction) {
  if (interaction.commandName === "pix") {
    await interaction.showModal(buildPixModal());
    return;
  }

  if (interaction.commandName === "sacar") {
    await interaction.showModal(buildWithdrawModal());
    return;
  }

  if (interaction.commandName === "saldo") {
    await handleBalance(interaction);
  }
}

async function handleModalSubmit(interaction) {
  if (interaction.customId === "pix:create") {
    await handleCreatePix(interaction);
    return;
  }

  if (interaction.customId === "withdraw:request") {
    await handleWithdrawRequest(interaction);
  }
}

async function handleCreatePix(interaction) {
  const amount = parseMoney(interaction.fields.getTextInputValue("amount"));
  const description =
    interaction.fields.getTextInputValue("description")?.trim() ||
    `Pix Discord ${interaction.user.username}`;
  const publicMessage = parseYesNo(interaction.fields.getTextInputValue("publicMessage"));

  if (!Number.isFinite(amount) || amount <= 0) {
    await interaction.reply({ content: "Valor do Pix invalido.", ...ephemeralOptions() });
    return;
  }

  await interaction.deferReply(ephemeralOptions(!publicMessage));

  const payer = await resolveDefaultPayer();
  const transactionId = `discord-${interaction.id}`;
  const response = await misticPay.createTransaction({
    amount,
    payerName: payer.name,
    payerDocument: payer.document,
    transactionId,
    description,
    projectWebhook: config.misticPay.projectWebhookUrl,
  });

  await interaction.editReply(buildPixResultPayload(response, amount, transactionId));
}

async function handleWithdrawRequest(interaction) {
  const kind = normalizeWithdrawKind(interaction.fields.getTextInputValue("method"));
  const amount = parseMoney(interaction.fields.getTextInputValue("amount"));
  const destination = interaction.fields.getTextInputValue("destination").trim();
  const detail = interaction.fields.getTextInputValue("detail")?.trim() || "";
  const description =
    interaction.fields.getTextInputValue("description")?.trim() ||
    `Saque solicitado por ${interaction.user.tag}`;

  if (kind === "pix") {
    await createPixWithdrawConfirmation(interaction, { amount, destination, detail, description });
    return;
  }

  if (kind === "crypto") {
    await createCryptoWithdrawConfirmation(interaction, { amount, destination, description });
    return;
  }

  await interaction.reply({
    content: "Tipo de saque invalido. Use `pix` ou `crypto`.",
    ...ephemeralOptions(),
  });
}

async function createPixWithdrawConfirmation(interaction, { amount, destination, detail, description }) {
  const pixKeyType = normalizePixKeyType(detail);
  const pixKey = normalizePixKey(destination, pixKeyType);
  const validationError = validatePixWithdraw({ amount, pixKey, pixKeyType });

  if (validationError) {
    await interaction.reply({ content: validationError, ...ephemeralOptions() });
    return;
  }

  const pendingId = randomUUID();
  const pending = {
    kind: "pix",
    userId: interaction.user.id,
    expiresAt: Date.now() + WITHDRAW_CONFIRM_TTL_MS,
    payload: {
      amount,
      pixKey,
      pixKeyType,
      description,
      projectWebhook: config.misticPay.projectWebhookUrl,
    },
    summary: {
      typeLabel: `Pix (${formatPixKeyType(pixKeyType)})`,
      amount,
      destinationLabel: "Chave Pix",
      destination: maskPixKey(pixKey, pixKeyType),
      description,
    },
  };

  pendingWithdrawals.set(pendingId, pending);
  await interaction.reply({
    embeds: [buildWithdrawConfirmEmbed(pending)],
    components: [buildWithdrawConfirmRow(pendingId, "pix")],
    ...ephemeralOptions(),
  });
}

async function createCryptoWithdrawConfirmation(interaction, { amount, destination, description }) {
  const wallet = destination.trim();
  const validationError = validateCryptoWithdraw({ amount, wallet });

  if (validationError) {
    await interaction.reply({ content: validationError, ...ephemeralOptions() });
    return;
  }

  await interaction.deferReply(ephemeralOptions());

  const feesResponse = await misticPay.getCryptoFees().catch(() => null);
  const pendingId = randomUUID();
  const pending = {
    kind: "crypto",
    userId: interaction.user.id,
    expiresAt: Date.now() + WITHDRAW_CONFIRM_TTL_MS,
    payload: {
      amount,
      wallet,
      projectWebhook: config.misticPay.projectWebhookUrl,
    },
    summary: {
      typeLabel: "Crypto USDT BEP20",
      amount,
      destinationLabel: "Wallet",
      destination: maskWallet(wallet),
      description,
      feesResponse,
    },
  };

  pendingWithdrawals.set(pendingId, pending);
  await interaction.editReply({
    embeds: [buildWithdrawConfirmEmbed(pending)],
    components: [buildWithdrawConfirmRow(pendingId, "crypto")],
  });
}

async function handleButton(interaction) {
  if (!interaction.customId.startsWith("withdraw:")) return;

  const [, action, pendingId] = interaction.customId.split(":");
  const pending = pendingWithdrawals.get(pendingId);

  if (!pending) {
    await interaction.reply({
      content: "Essa confirmacao expirou ou ja foi usada.",
      ...ephemeralOptions(),
    });
    return;
  }

  if (pending.userId !== interaction.user.id) {
    await interaction.reply({
      content: "Somente quem solicitou o saque pode confirmar ou cancelar.",
      ...ephemeralOptions(),
    });
    return;
  }

  if (Date.now() > pending.expiresAt) {
    pendingWithdrawals.delete(pendingId);
    await interaction.update({
      content: "Confirmacao expirada. Rode `/sacar` novamente.",
      embeds: [],
      components: [],
    });
    return;
  }

  if (action === "cancel") {
    pendingWithdrawals.delete(pendingId);
    await interaction.update({
      content: "Saque cancelado.",
      embeds: [],
      components: [],
    });
    return;
  }

  if (action !== "confirm") return;

  pendingWithdrawals.delete(pendingId);
  await interaction.deferUpdate();

  const response =
    pending.kind === "crypto"
      ? await misticPay.cryptoWithdraw(pending.payload)
      : await misticPay.withdraw(pending.payload);

  const data = response?.data ?? {};
  const embed = baseEmbed("Saque enviado", COLORS.success)
    .setDescription(response?.message || "Saque enviado para processamento.")
    .addFields(
      { name: "Tipo", value: pending.summary.typeLabel, inline: true },
      { name: "Valor", value: formatBrl(pending.payload.amount), inline: true },
      { name: "Status", value: String(data.status || "QUEUED"), inline: true },
    );

  if (data.transactionId) {
    embed.addFields({ name: "Transacao", value: String(data.transactionId), inline: true });
  }

  if (data.jobId) {
    embed.addFields({ name: "Job", value: String(data.jobId), inline: false });
  }

  if (data.message) {
    embed.addFields({ name: "Retorno", value: truncate(String(data.message), 1024), inline: false });
  }

  await interaction.editReply({
    content: "",
    embeds: [embed],
    components: [],
  });
}

async function handleBalance(interaction) {
  await interaction.deferReply(ephemeralOptions());

  const response = await misticPay.getBalance();
  const balance = response?.data?.balance;

  const embed = baseEmbed("Saldo MisticPay", COLORS.info)
    .setDescription("Saldo disponivel para operacoes.")
    .addFields({ name: "Disponivel", value: formatBrl(Number(balance ?? 0)), inline: true });

  await interaction.editReply({ embeds: [embed] });
}

function buildPixModal() {
  return new ModalBuilder()
    .setCustomId("pix:create")
    .setTitle("Gerar Pix")
    .addComponents(
      modalTextRow("amount", "Valor em reais", "Ex: 25,00", true),
      modalTextRow("description", "Descricao", "Opcional", false),
      modalTextRow("publicMessage", "Publico no canal?", "sim ou nao", false),
    );
}

function buildWithdrawModal() {
  return new ModalBuilder()
    .setCustomId("withdraw:request")
    .setTitle("Sacar")
    .addComponents(
      modalTextRow("method", "Tipo", "pix ou crypto", true),
      modalTextRow("amount", "Valor em reais", "Ex: 50,00", true),
      modalTextRow("destination", "Destino", "Chave Pix ou wallet 0x...", true),
      modalTextRow("detail", "Detalhe", "Pix: cpf/cnpj/email/telefone/aleatoria | Crypto: usdt", false),
      modalTextRow("description", "Descricao", "Opcional", false),
    );
}

function modalTextRow(customId, label, placeholder, required, style = TextInputStyle.Short) {
  return new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setPlaceholder(placeholder)
      .setRequired(required)
      .setStyle(style)
      .setMaxLength(style === TextInputStyle.Paragraph ? 400 : 140),
  );
}

function buildWithdrawConfirmRow(pendingId, kind) {
  const label = kind === "crypto" ? "Confirmar crypto" : "Confirmar Pix";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`withdraw:confirm:${pendingId}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`withdraw:cancel:${pendingId}`)
      .setLabel("Cancelar")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildWithdrawConfirmEmbed(pending) {
  const embed = baseEmbed("Confirmar saque", COLORS.warning)
    .setDescription("Confira os dados antes de enviar para a MisticPay.")
    .addFields(
      { name: "Tipo", value: pending.summary.typeLabel, inline: true },
      { name: "Valor", value: formatBrl(pending.summary.amount), inline: true },
      { name: pending.summary.destinationLabel, value: pending.summary.destination, inline: false },
    )
    .setFooter({ text: "Essa confirmacao expira em 2 minutos." });

  if (pending.summary.description) {
    embed.addFields({ name: "Descricao", value: truncate(pending.summary.description, 1024), inline: false });
  }

  if (pending.kind === "crypto" && pending.summary.feesResponse) {
    addCryptoFeeFields(embed, pending.summary.feesResponse);
  }

  return embed;
}

function buildPixResultPayload(response, amount, fallbackTransactionId) {
  const transaction = response?.data ?? {};
  const status = String(transaction.transactionState || "PENDENTE");
  const embed = baseEmbed("Pix gerado", COLORS.success)
    .setDescription("Cobranca criada e pronta para pagamento.")
    .addFields(
      { name: "Valor", value: formatBrl(amount), inline: true },
      { name: "Status", value: status, inline: true },
      { name: "Transacao", value: String(transaction.transactionId || fallbackTransactionId), inline: true },
    );

  const files = [];
  const qrAttachment = makeQrAttachment(transaction.qrCodeBase64);

  if (qrAttachment) {
    files.push(qrAttachment);
    embed.setImage("attachment://pix-qrcode.png");
  } else if (transaction.qrcodeUrl) {
    embed.setImage(transaction.qrcodeUrl);
  }

  const copyPaste = transaction.copyPaste ? String(transaction.copyPaste) : "";
  const contentParts = [response?.message || "Transacao criada com sucesso."];

  if (copyPaste && copyPaste.length <= 1700) {
    contentParts.push(`Pix copia e cola:\n\`\`\`\n${copyPaste}\n\`\`\``);
  } else if (copyPaste) {
    files.push(new AttachmentBuilder(Buffer.from(copyPaste, "utf8"), { name: "pix-copia-e-cola.txt" }));
    contentParts.push("Pix copia e cola enviado no arquivo anexo.");
  }

  return {
    content: contentParts.join("\n\n"),
    embeds: [embed],
    files,
  };
}

function addCryptoFeeFields(embed, response) {
  const data = response?.data ?? {};
  const quote = data.quote ?? {};
  const fees = data.fees ?? {};

  if (quote.brlPerUSD !== undefined) {
    embed.addFields({ name: "Cotacao", value: `${formatNumber(Number(quote.brlPerUSD))} BRL/USD`, inline: true });
  }

  if (fees.platformFeePercentage !== undefined) {
    embed.addFields({ name: "Taxa plataforma", value: `${fees.platformFeePercentage}%`, inline: true });
  }

  if (quote.networkFee !== undefined || fees.networkFee !== undefined) {
    embed.addFields({
      name: "Taxa rede",
      value: formatBrl(Number(quote.networkFee ?? fees.networkFee)),
      inline: true,
    });
  }

  if (quote.fixedFeeUSDT !== undefined) {
    embed.addFields({ name: "Taxa fixa", value: `${formatNumber(Number(quote.fixedFeeUSDT))} USDT`, inline: true });
  }
}

async function replyWithError(interaction, error) {
  console.error(error);

  const message =
    error instanceof MisticPayError
      ? `Erro da MisticPay: ${error.message}`
      : `Erro ao processar comando: ${error.message || "erro desconhecido"}`;

  const payload = { content: message.slice(0, 1900), components: [], embeds: [] };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload).catch(() => undefined);
  } else {
    await interaction.reply({ ...payload, ...ephemeralOptions() }).catch(() => undefined);
  }
}

function cleanupExpiredWithdrawals() {
  const now = Date.now();
  for (const [id, pending] of pendingWithdrawals.entries()) {
    if (pending.expiresAt <= now) pendingWithdrawals.delete(id);
  }
}

async function resolveDefaultPayer() {
  if (payerProfileCache) return payerProfileCache;

  const configuredDocument = onlyDigits(config.misticPay.defaultPayerDocument || "");
  if (configuredDocument) {
    payerProfileCache = {
      name: config.misticPay.defaultPayerName,
      document: configuredDocument,
    };
    return payerProfileCache;
  }

  const response = await misticPay.getUserInfo();
  const user = response?.data ?? {};
  const document = onlyDigits(user.document || "");

  if (!document) {
    throw new MisticPayError(
      "Nao achei documento na conta MisticPay. Preencha MISTICPAY_DEFAULT_PAYER_DOCUMENT no .env para gerar Pix sem pedir CPF no Discord.",
    );
  }

  payerProfileCache = {
    name: user.name || config.misticPay.defaultPayerName,
    document,
  };
  return payerProfileCache;
}

function baseEmbed(title, color) {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setTimestamp(new Date())
    .setFooter({ text: "MisticPay" });
}

function makeQrAttachment(dataUri) {
  if (!dataUri) return null;
  const match = String(dataUri).match(/^data:image\/(?:png|jpeg|jpg);base64,(.+)$/i);
  if (!match) return null;
  return new AttachmentBuilder(Buffer.from(match[1], "base64"), { name: "pix-qrcode.png" });
}

function validatePixWithdraw({ amount, pixKey, pixKeyType }) {
  if (!Number.isFinite(amount) || amount <= 0) return "Valor de saque invalido.";
  if (!["CPF", "CNPJ", "EMAIL", "TELEFONE", "CHAVE_ALEATORIA"].includes(pixKeyType)) {
    return "Tipo de chave Pix invalido. Use: cpf, cnpj, email, telefone ou aleatoria.";
  }
  if (!pixKey) return "Chave Pix obrigatoria.";
  if (pixKeyType === "CPF" && onlyDigits(pixKey).length !== 11) return "CPF da chave Pix deve ter 11 numeros.";
  if (pixKeyType === "CNPJ" && onlyDigits(pixKey).length !== 14) return "CNPJ da chave Pix deve ter 14 numeros.";
  if (pixKeyType === "EMAIL" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pixKey)) return "Email da chave Pix invalido.";
  return null;
}

function validateCryptoWithdraw({ amount, wallet }) {
  if (!Number.isFinite(amount) || amount < CRYPTO_MIN_BRL || amount > CRYPTO_MAX_BRL) {
    return `Saque crypto deve ficar entre ${formatBrl(CRYPTO_MIN_BRL)} e ${formatBrl(CRYPTO_MAX_BRL)}.`;
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return "Wallet invalida. Use um endereco BEP20 no formato 0x + 40 caracteres hexadecimais.";
  }

  return null;
}

function normalizeWithdrawKind(value) {
  const normalized = String(value).trim().toLowerCase();
  if (["pix", "p"].includes(normalized)) return "pix";
  if (["crypto", "cripto", "usdt", "bep20"].includes(normalized)) return "crypto";
  return normalized;
}

function normalizePixKey(value, pixKeyType) {
  const trimmed = value.trim();
  if (pixKeyType === "CPF" || pixKeyType === "CNPJ") return onlyDigits(trimmed);
  if (pixKeyType === "TELEFONE") return trimmed.replace(/[()\s-]/g, "");
  return trimmed;
}

function normalizePixKeyType(value) {
  const normalized = String(value)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s-]/g, "_");

  const aliases = {
    CPF: "CPF",
    CNPJ: "CNPJ",
    EMAIL: "EMAIL",
    E_MAIL: "EMAIL",
    TELEFONE: "TELEFONE",
    CELULAR: "TELEFONE",
    PHONE: "TELEFONE",
    ALEATORIA: "CHAVE_ALEATORIA",
    CHAVE_ALEATORIA: "CHAVE_ALEATORIA",
    RANDOM: "CHAVE_ALEATORIA",
  };

  return aliases[normalized] || normalized;
}

function onlyDigits(value) {
  return String(value).replace(/\D/g, "");
}

function parseMoney(value) {
  const clean = String(value).trim().replace(/^R\$\s*/i, "").replace(/\s/g, "");
  const normalized = clean.includes(",") ? clean.replace(/\./g, "").replace(",", ".") : clean;
  return roundMoney(Number(normalized));
}

function parseYesNo(value) {
  const normalized = String(value).trim().toLowerCase();
  return ["s", "sim", "y", "yes", "true", "1", "publico", "publica"].includes(normalized);
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function formatBrl(value) {
  if (!Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "N/A";
  return new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: 8,
  }).format(value);
}

function formatPixKeyType(type) {
  const labels = {
    CPF: "CPF",
    CNPJ: "CNPJ",
    EMAIL: "Email",
    TELEFONE: "Telefone",
    CHAVE_ALEATORIA: "Chave aleatoria",
  };

  return labels[type] || type;
}

function maskPixKey(value, type) {
  if (type === "EMAIL") {
    const [name, domain] = value.split("@");
    if (!domain) return value;
    return `${name.slice(0, 2)}***@${domain}`;
  }

  if (type === "CHAVE_ALEATORIA") {
    return `${value.slice(0, 6)}...${value.slice(-4)}`;
  }

  const clean = value.replace(/\s/g, "");
  if (clean.length <= 6) return clean;
  return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
}

function maskWallet(wallet) {
  return `${wallet.slice(0, 8)}...${wallet.slice(-6)}`;
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}
