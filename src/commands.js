import {
  SlashCommandBuilder,
} from "discord.js";

export const commandBuilders = [
  new SlashCommandBuilder()
    .setName("pix")
    .setDescription("Gera uma cobrança Pix instantânea"),

  new SlashCommandBuilder()
    .setName("saldo")
    .setDescription("Consulta o seu saldo disponível na MisticPay"),

  new SlashCommandBuilder()
    .setName("sacar")
    .setDescription("Inicia o fluxo de saque via Pix ou Crypto"),

  new SlashCommandBuilder()
    .setName("crypto")
    .setDescription("Comandos relacionados a Criptomoedas")
    .addSubcommand(sub => 
      sub.setName("taxas")
         .setDescription("Mostra a cotação e taxas atuais para saque em USDT (BEP20)")
    ),
];

export const commandsJson = commandBuilders.map((command) => command.toJSON());
