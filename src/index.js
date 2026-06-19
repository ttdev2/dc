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
  StringSelectMenuBuilder,
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
const userWithdrawState = new Map();
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
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction);
    }
  } catch (error) {
    await replyWithError(interaction, error);
  }
});

setInterval(cleanupExpiredWithdrawals, 60_000).unref();

await client.login(config.discord.token);

async function handleCommand(interaction) {
  const { commandName, options } = interaction;

  if (commandName === "pix") {
    await interaction.showModal(buildPixModal());
    return;
  }

  if (commandName === "sacar") {
    await handleWithdrawCommand(interaction);
    return;
  }

  if (commandName === "saldo") {
    await handleBalance(interaction);
    return;
  }

  if (commandName === "crypto") {
    const subcommand = options.getSubcommand();
    if (subcommand === "taxas") {
      await handleCryptoFees(interaction);
    }
  }
}

async function handleCryptoFees(interaction) {
  await interaction.deferReply(ephemeralOptions());
  try {
    const response = await misticPay.getCryptoFees();
    const embed = baseEmbed("Taxas e Cotação Crypto", COLORS.info)
      .setDescription("Informações atuais para saques em USDT (BEP20).");
    
    addCryptoFeeFields(embed, response);
    
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("withdraw:start_crypto")
        .setLabel("Sacar USDT agora")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("🪙")
    );

    await interaction.editReply({ embeds: [embed], components: [row] });
  } catch (error) {
    await replyWithError(interaction, error);
  }
}

async function handleWithdrawCommand(interaction) {
  const embed = baseEmbed("Solicitar Saque", COLORS.brand)
    .setDescription("Escolha o método desejado para realizar o saque.")
    .addFields(
      { name: "Opções", value: "• **Pix:** Transferência instantânea\n• **Crypto:** USDT (BEP20)" }
    );

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("withdraw:select_method")
      .setPlaceholder("Selecione o método de saque")
      .addOptions([
        { label: "Pix", value: "pix", description: "Saque via Pix", emoji: "💸" },
        { label: "Crypto (USDT BEP20)", value: "crypto", description: "Saque via Criptomoeda", emoji: "🪙" },
      ])
  );

  await interaction.reply({ embeds: [embed], components: [row], ...ephemeralOptions() });
}

async function handleSelectMenu(interaction) {
  if (interaction.customId === "withdraw:select_method") {
    const method = interaction.values[0];
    
    if (method === "pix") {
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("withdraw:select_pix_type")
          .setPlaceholder("Selecione o tipo de chave Pix")
          .addOptions([
            { label: "CPF", value: "CPF", emoji: "🆔" },
            { label: "CNPJ", value: "CNPJ", emoji: "🏢" },
            { label: "E-mail", value: "EMAIL", emoji: "📧" },
            { label: "Telefone", value: "TELEFONE", emoji: "📱" },
            { label: "Chave Aleatória", value: "ALEATORIA", emoji: "🔀" },
          ])
      );

      await interaction.update({
        content: "Selecione o **tipo de chave Pix**:",
        embeds: [],
        components: [row]
      });
    } else if (method === "crypto") {
      await interaction.showModal(buildWithdrawModal("crypto", "USDT"));
    }
    return;
  }

  if (interaction.customId === "withdraw:select_pix_type") {
    const pixType = interaction.values[0];
    userWithdrawState.set(interaction.user.id, { pixType });
    await interaction.showModal(buildWithdrawModal("pix", pixType));
  }
}

async function handleModalSubmit(interaction) {
  if (interaction.customId === "pix:create") {
    await handleCreatePix(interaction);
    return;
  }

  if (interaction.customId === "withdraw:modal_pix") {
    const state = userWithdrawState.get(interaction.user.id);
    if (!state) {
      await interaction.reply({ content: "Sessão expirada. Tente novamente.", ...ephemeralOptions() });
      return;
    }
    await handleWithdrawRequest(interaction, "pix", state.pixType);
    userWithdrawState.delete(interaction.user.id);
    return;
  }

  if (interaction.customId === "withdraw:modal_crypto") {
    await handleWithdrawRequest(interaction, "crypto");
  }
}

async function handleCreatePix(interaction) {
  const amountInput = interaction.fields.getTextInputValue("amount");
  const amount = parseMoney(amountInput);
  const description =
    interaction.fields.getTextInputValue("description")?.trim() ||
    `Pix Discord ${interaction.user.username}`;

  if (!Number.isFinite(amount) || amount <= 0) {
    await interaction.reply({ content: "Valor do Pix inválido.", ...ephemeralOptions() });
    return;
  }

  await interaction.deferReply(ephemeralOptions(true));

  try {
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
  } catch (error) {
    await replyWithError(interaction, error);
  }
}

async function handleWithdrawRequest(interaction, kind, pixType = null) {
  const amount = parseMoney(interaction.fields.getTextInputValue("amount"));
  const destination = interaction.fields.getTextInputValue("destination").trim();
  const description = interaction.fields.getTextInputValue("description")?.trim() || `Saque ${kind} via Discord`;

  if (kind === "pix") {
    await createPixWithdrawConfirmation(interaction, { amount, destination, pixKeyType: pixType, description });
  } else if (kind === "crypto") {
    await createCryptoWithdrawConfirmation(interaction, { amount, destination, description });
  }
}

async function createPixWithdrawConfirmation(interaction, { amount, destination, pixKeyType, description }) {
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
    await (interaction.replied || interaction.deferred ? interaction.editReply({ content: validationError }) : interaction.reply({ content: validationError, ...ephemeralOptions() }));
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply(ephemeralOptions());
  }

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
    content: "",
    embeds: [buildWithdrawConfirmEmbed(pending)],
    components: [buildWithdrawConfirmRow(pendingId, "crypto")],
  });
}

async function handleButton(interaction) {
  if (interaction.customId === "withdraw:start_crypto") {
    await interaction.showModal(buildWithdrawModal("crypto", "USDT"));
    return;
  }

  if (!interaction.customId.startsWith("withdraw:")) return;

  const [, action, pendingId] = interaction.customId.split(":");
  const pending = pendingWithdrawals.get(pendingId);

  if (!pending) {
    await interaction.reply({
      content: "Essa confirmação expirou ou já foi usada.",
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
      content: "Confirmação expirada. Use `/sacar` novamente.",
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
    embed.addFields({ name: "Transação", value: String(data.transactionId), inline: true });
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
    .setDescription("Seu saldo disponível para operações.")
    .addFields({ name: "Disponível", value: formatBrl(Number(balance ?? 0)), inline: true });

  await interaction.editReply({ embeds: [embed] });
}

function buildPixModal() {
  return new ModalBuilder()
    .setCustomId("pix:create")
    .setTitle("Gerar Cobrança Pix")
    .addComponents(
      modalTextRow("amount", "Valor (R$)", "Ex: 25,00", true),
      modalTextRow("description", "Descrição", "Opcional", false),
    );
}

function buildWithdrawModal(kind, detail) {
  const isPix = kind === "pix";
  const modal = new ModalBuilder()
    .setCustomId(isPix ? "withdraw:modal_pix" : "withdraw:modal_crypto")
    .setTitle(`Saque ${isPix ? "Pix" : "Crypto"}`);

  const rows = [
    modalTextRow("amount", "Valor (R$)", "Ex: 50,00", true),
    modalTextRow("destination", isPix ? `Chave Pix (${detail})` : "Carteira BEP20", "Digite aqui...", true),
    modalTextRow("description", "Descrição", "Opcional", false),
  ];

  modal.addComponents(...rows);
  return modal;
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
  const label = kind === "crypto" ? "Confirmar Saque Crypto" : "Confirmar Saque Pix";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`withdraw:confirm:${pendingId}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`withdraw:cancel:${pendingId}`)
      .setLabel("Cancelar")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildWithdrawConfirmEmbed(pending) {
  const embed = baseEmbed("Confirmar Saque", COLORS.warning)
    .setDescription("Confira os dados abaixo antes de confirmar o saque.")
    .addFields(
      { name: "Tipo", value: pending.summary.typeLabel, inline: true },
      { name: "Valor", value: formatBrl(pending.summary.amount), inline: true },
      { name: pending.summary.destinationLabel, value: pending.summary.destination, inline: false },
    )
    .setFooter({ text: "Esta confirmação expira em 2 minutos." });

  if (pending.summary.description) {
    embed.addFields({ name: "Descrição", value: truncate(pending.summary.description, 1024), inline: false });
  }

  if (pending.kind === "crypto" && pending.summary.feesResponse) {
    addCryptoFeeFields(embed, pending.summary.feesResponse);
  }

  return embed;
}

function buildPixResultPayload(response, amount, fallbackTransactionId) {
  const transaction = response?.data ?? {};
  const status = String(transaction.transactionState || "PENDENTE");
  const embed = baseEmbed("Pix Gerado", COLORS.success)
    .setDescription("Sua cobrança foi gerada. Pague usando o QR Code ou o código Copia e Cola.")
    .addFields(
      { name: "Valor", value: formatBrl(amount), inline: true },
      { name: "Status", value: status, inline: true },
      { name: "Transação", value: String(transaction.transactionId || fallbackTransactionId), inline: true },
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
  const contentParts = [];

  if (copyPaste) {
    contentParts.push(`**Pix Copia e Cola:**\n\`\`\`\n${copyPaste}\n\`\`\``);
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
    embed.addFields({ name: "Cotação", value: `${formatNumber(Number(quote.brlPerUSD))} BRL/USD`, inline: true });
  }

  if (fees.platformFeePercentage !== undefined) {
    embed.addFields({ name: "Taxa Plataforma", value: `${fees.platformFeePercentage}%`, inline: true });
  }

  if (quote.networkFee !== undefined || fees.networkFee !== undefined) {
    embed.addFields({
      name: "Taxa Rede",
      value: formatBrl(Number(quote.networkFee ?? fees.networkFee)),
      inline: true,
    });
  }
}

async function replyWithError(interaction, error) {
  console.error(error);

  const message =
    error instanceof MisticPayError
      ? `Erro MisticPay: ${error.message}`
      : "Ocorreu um erro inesperado ao processar sua solicitação.";

  const embed = baseEmbed("Erro", COLORS.danger).setDescription(message);

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed], components: [], files: [] });
  } else {
    await interaction.reply({ embeds: [embed], ...ephemeralOptions() });
  }
}

function cleanupExpiredWithdrawals() {
  const now = Date.now();
  for (const [id, pending] of pendingWithdrawals.entries()) {
    if (now > pending.expiresAt) {
      pendingWithdrawals.delete(id);
    }
  }
}

async function resolveDefaultPayer() {
  if (payerProfileCache) return payerProfileCache;

  if (config.misticPay.defaultPayerDocument) {
    payerProfileCache = {
      name: config.misticPay.defaultPayerName,
      document: onlyDigits(config.misticPay.defaultPayerDocument),
    };
    return payerProfileCache;
  }

  const response = await misticPay.getUserInfo();
  const user = response?.data ?? {};
  const document = onlyDigits(user.document || "");

  if (!document) {
    throw new MisticPayError(
      "Documento não configurado. Defina MISTICPAY_DEFAULT_PAYER_DOCUMENT no .env.",
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
    .setFooter({ text: "MisticPay - Bot de Pagamentos" });
}

function makeQrAttachment(dataUri) {
  if (!dataUri) return null;
  const match = String(dataUri).match(/^data:image\/(?:png|jpeg|jpg);base64,(.+)$/i);
  if (!match) return null;
  return new AttachmentBuilder(Buffer.from(match[1], "base64"), { name: "pix-qrcode.png" });
}

function validatePixWithdraw({ amount, pixKey, pixKeyType }) {
  if (!Number.isFinite(amount) || amount <= 0) return "Valor de saque inválido.";
  if (!["CPF", "CNPJ", "EMAIL", "TELEFONE", "ALEATORIA"].includes(pixKeyType)) {
    return "Tipo de chave Pix inválido.";
  }
  if (!pixKey) return "Chave Pix obrigatória.";
  if (pixKeyType === "CPF" && onlyDigits(pixKey).length !== 11) return "CPF deve ter 11 números.";
  if (pixKeyType === "CNPJ" && onlyDigits(pixKey).length !== 14) return "CNPJ deve ter 14 números.";
  if (pixKeyType === "EMAIL" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pixKey)) return "E-mail inválido.";
  return null;
}

function validateCryptoWithdraw({ amount, wallet }) {
  if (!Number.isFinite(amount) || amount < CRYPTO_MIN_BRL || amount > CRYPTO_MAX_BRL) {
    return `Saque crypto deve ser entre ${formatBrl(CRYPTO_MIN_BRL)} e ${formatBrl(CRYPTO_MAX_BRL)}.`;
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return "Carteira inválida. Use um endereço BEP20 (0x...).";
  }

  return null;
}

function normalizePixKey(value, pixKeyType) {
  const trimmed = value.trim();
  if (pixKeyType === "CPF" || pixKeyType === "CNPJ") return onlyDigits(trimmed);
  if (pixKeyType === "TELEFONE") return trimmed.replace(/[()\s-]/g, "");
  return trimmed;
}

function onlyDigits(value) {
  return String(value).replace(/\D/g, "");
}

function parseMoney(value) {
  const clean = String(value).trim().replace(/^R\$\s*/i, "").replace(/\s/g, "");
  const normalized = clean.includes(",") ? clean.replace(/\./g, "").replace(",", ".") : clean;
  return roundMoney(Number(normalized));
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
    EMAIL: "E-mail",
    TELEFONE: "Telefone",
    ALEATORIA: "Chave Aleatória",
  };

  return labels[type] || type;
}

function maskPixKey(value, type) {
  if (type === "EMAIL") {
    const [name, domain] = value.split("@");
    if (!domain) return value;
    return `${name.slice(0, 2)}***@${domain}`;
  }

  if (type === "ALEATORIA") {
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
