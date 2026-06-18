import {
  SlashCommandBuilder,
} from "discord.js";

export const commandBuilders = [
  new SlashCommandBuilder()
    .setName("pix")
    .setDescription("Gera uma cobranca Pix"),

  new SlashCommandBuilder()
    .setName("saldo")
    .setDescription("Consulta o saldo disponivel na MisticPay"),

  new SlashCommandBuilder()
    .setName("sacar")
    .setDescription("Solicita saque Pix ou crypto"),
];

export const commandsJson = commandBuilders.map((command) => command.toJSON());
