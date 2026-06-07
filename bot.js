const { Client, GatewayIntentBits, SlashCommandBuilder } = require("discord.js");

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName("ping")
      .setDescription("Prueft, ob der Bot antwortet."),
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Zeigt Browser- und Wiedergabestatus an."),
    new SlashCommandBuilder()
      .setName("join")
      .setDescription("Bestaetigt den Start / spielt den Browser weiter ab."),
    new SlashCommandBuilder()
      .setName("leave")
      .setDescription("Pausiert die Browser-Wiedergabe und antwortet sofort."),
  ].map((cmd) => cmd.toJSON());
}

async function formatBrowserStatus(browserControls) {
  if (!browserControls) return "Browser: startet noch oder ist deaktiviert.";

  const volume = typeof browserControls.getVolume === "function" ? browserControls.getVolume() : null;
  const nowPlaying = typeof browserControls.nowPlaying === "function" ? await browserControls.nowPlaying() : null;

  const lines = ["Browser: bereit."];
  if (volume !== null) lines.push(`Lautstaerke: ${volume}%`);
  if (nowPlaying && nowPlaying.title) {
    const parts = [nowPlaying.title];
    if (nowPlaying.game) parts.push(nowPlaying.game);
    lines.push(`Now playing: ${parts.join(" — ")}`);
  } else {
    lines.push("Now playing: nichts erkannt.");
  }
  return lines.join("\n");
}

async function startDiscordBot({ token, guildId }, getBrowserControls) {
  if (!token) {
    return null;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  const commands = buildCommands();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  client.once("ready", async () => {
    try {
      console.log(`[discord] Eingeloggt als ${client.user.tag}`);
      try {
        if (guildId) {
          const guild = await client.guilds.fetch(guildId);
          await guild.commands.set(commands);
          console.log(`[discord] Slash-Commands fuer Guild ${guildId} registriert.`);
        } else if (client.application) {
          await client.application.commands.set(commands);
          console.log("[discord] Globale Slash-Commands registriert.");
        }
      } catch (err) {
        console.warn("[discord] Slash-Command-Registrierung fehlgeschlagen:", err.message);
      }
      readyResolve(client);
    } catch (err) {
      readyReject(err);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      await interaction.deferReply({ ephemeral: true });
      const browserControls = typeof getBrowserControls === "function" ? getBrowserControls() : null;

      if (interaction.commandName === "ping") {
        await interaction.editReply("Pong.");
        return;
      }

      if (interaction.commandName === "status") {
        await interaction.editReply(await formatBrowserStatus(browserControls));
        return;
      }

      if (interaction.commandName === "join") {
        if (browserControls && typeof browserControls.play === "function") {
          await browserControls.play();
          await interaction.editReply("Browser-Wiedergabe gestartet bzw. weitergefuehrt.");
        } else {
          await interaction.editReply("Browser ist noch nicht bereit oder deaktiviert.");
        }
        return;
      }

      if (interaction.commandName === "leave") {
        if (browserControls && typeof browserControls.pause === "function") {
          await browserControls.pause();
          await interaction.editReply("Browser-Wiedergabe pausiert.");
        } else {
          await interaction.editReply("Browser ist noch nicht bereit oder deaktiviert.");
        }
        return;
      }

      await interaction.editReply(`Befehl /${interaction.commandName} empfangen.`);
    } catch (err) {
      const message = `Fehler bei /${interaction.commandName}: ${err.message}`;
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(message);
        } else {
          await interaction.reply({ content: message, ephemeral: true });
        }
      } catch {
        // best effort
      }
    }
  });

  client.on("error", (err) => {
    console.error("[discord] Client-Fehler:", err.message);
  });

  client.on("shardError", (err) => {
    console.error("[discord] Shard-Fehler:", err.message);
  });

  client.login(token).catch((err) => {
    readyReject(err);
  });

  await ready;

  return {
    client,
    ready,
    stop: async () => {
      try {
        await client.destroy();
      } catch {
        // ignore
      }
    },
  };
}

module.exports = { startDiscordBot };

