import { REST, Routes } from "discord.js";
import { fileURLToPath } from "node:url";
import { commandsJson } from "./commands.js";
import { config } from "./config.js";

export async function deployCommands() {
  if (!config.discord.token) throw new Error("DISCORD_TOKEN nao configurado.");
  if (!config.discord.clientId) throw new Error("DISCORD_CLIENT_ID nao configurado.");

  const rest = new REST({ version: "10" }).setToken(config.discord.token);
  const route = config.discord.guildId
    ? Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId)
    : Routes.applicationCommands(config.discord.clientId);

  await rest.put(route, { body: commandsJson });

  return {
    scope: config.discord.guildId ? `guild ${config.discord.guildId}` : "global",
    count: commandsJson.length,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  deployCommands()
    .then((result) => {
      console.log(`Registrados ${result.count} comandos slash em ${result.scope}.`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
