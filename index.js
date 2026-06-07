// ---------------------------------------------------------------------------
//  DCNintendoMusic
//  Discord-Bot, der das Audio deines virtuellen Audiokabels (= nur der
//  Browser-Ton von music.nintendo.com) live in einen Server-Voice-Channel
//  streamt. Optional startet er Nintendo Music selbst in einem versteckten
//  Browser (siehe browser.js) und steuert Wiedergabe/Suche per Slash-Commands.
//
//  Slash-Commands:
//    /join /leave /status
//    /play /pause /skip /loop[modus] /volumeup /volumedown
//    /track <name>   /queue <name>
// ---------------------------------------------------------------------------

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// FFmpeg-Pfad: per config.ffmpegPath ueberschreibbar (gesetzt nach config-Load).
// Wichtig auf Linux/Pi, weil "ffmpeg-static" oft KEINEN PulseAudio-Input kann
// -> dort System-FFmpeg: "ffmpegPath": "ffmpeg" (vorher: sudo apt install ffmpeg).
let ffmpegPath = require("ffmpeg-static");
const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  MessageFlags,
  EmbedBuilder,
  ActivityType,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  getVoiceConnection,
  entersState,
} = require("@discordjs/voice");

// --- Konfiguration laden ---------------------------------------------------
const configPath = path.join(__dirname, "config.json");
if (!fs.existsSync(configPath)) {
  console.error(
    "config.json fehlt. Kopiere config.example.json -> config.json und trage\n" +
      "deinen Bot-Token sowie das Audio-Geraet ein."
  );
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

if (!config.token || config.token.startsWith("HIER_")) {
  console.error("Bitte einen gueltigen Bot-Token in config.json eintragen.");
  process.exit(1);
}
// audioDevice ist nur unter Windows (DirectShow/VB-Cable) Pflicht. Auf Linux
// kommt der Ton ueber den PulseAudio-Monitor (siehe captureInputArgs()).
if (process.platform === "win32" && !config.audioDevice) {
  console.error(
    'Bitte "audioDevice" in config.json eintragen (siehe: npm run devices).'
  );
  process.exit(1);
}
// FFmpeg-Pfad ggf. aus config ueberschreiben (z. B. "ffmpeg" auf dem Pi).
if (config.ffmpegPath) ffmpegPath = config.ffmpegPath;

// Pro Server (Guild) merken wir uns den laufenden FFmpeg-Prozess.
/** @type {Map<string, import("node:child_process").ChildProcess>} */
const activeFfmpeg = new Map();

// --- Optionaler Hintergrund-Browser (Nintendo Music ohne sichtbares Fenster) -
// Per config.json: "browser": { "enabled": true, "visible": false, ... }
const browserCfg = config.browser ?? {};
const browserEnabled = browserCfg.enabled !== false;
let browserHandle = null;
let browserStarting = null;

// Startet den Browser einmalig (Singleton) und gibt das Handle zurueck.
async function ensureBrowser() {
  if (!browserEnabled) return null;
  if (browserHandle) return browserHandle;
  if (browserStarting) return browserStarting;

  const { startNintendoMusic } = require("./browser");
  // browserCfg-Felder (executablePath, audioSink, visible, …) durchreichen;
  // nicht gesetzte Felder fallen auf die Defaults in browser.js zurueck.
  browserStarting = startNintendoMusic({
    ...browserCfg,
    visible: !!browserCfg.visible,
  })
    .then((h) => {
      browserHandle = h;
      browserStarting = null;
      console.log("[browser] Hintergrund-Browser laeuft.");
      return h;
    })
    .catch((err) => {
      browserStarting = null;
      throw err;
    });
  return browserStarting;
}

async function stopBrowser() {
  if (browserHandle) {
    const h = browserHandle;
    browserHandle = null;
    await h.stop();
  }
}

// Browser nur stoppen, wenn keine Guild mehr streamt.
function stopBrowserIfIdle() {
  if (activeFfmpeg.size === 0) stopBrowser().catch(() => {});
}

// --- "Now Playing": Presence-Text + Embed-Karte pro Channel ----------------
// Hinweis: Das Cover-BILD kann nur als Embed im Text-Channel gezeigt werden.
// Die Bot-Presence ("Hoert …") unterstuetzt nur Text, kein Bild.
/** @type {Map<string, import("discord.js").TextBasedChannel>} */
const npChannels = new Map(); // guildId -> Channel, in dem /join lief
/** @type {Map<string, import("discord.js").Message>} */
const npMessages = new Map(); // guildId -> aktuell gepostete Karte
/** @type {Map<string, NodeJS.Timeout>} */
const npRestickTimers = new Map();
let npTimer = null;
let npLastKey = null;
let npLast = null; // zuletzt erkanntes { title, game, image }

const NP_AUTHOR = "Spielt gerade";

function startNowPlaying() {
  if (npTimer || !browserEnabled) return;
  npTimer = setInterval(() => updateNowPlaying().catch(() => {}), 4000);
}

function stopNowPlaying() {
  if (npTimer) {
    clearInterval(npTimer);
    npTimer = null;
  }
  npLastKey = null;
  npLast = null;
  client.user?.setActivity();
}

function makeNpEmbed(np) {
  const embed = new EmbedBuilder()
    .setAuthor({ name: NP_AUTHOR })
    .setTitle(np.title)
    .setColor(0xe60012); // Nintendo-Rot
  if (np.game) embed.setDescription(np.game);
  if (np.image) embed.setThumbnail(np.image);
  return embed;
}

// Embed fuer /track und /queue (mit Cover-Bild aus der Trefferkarte).
function trackEmbed(header, info) {
  const embed = new EmbedBuilder()
    .setAuthor({ name: header })
    .setTitle(info.title)
    .setColor(0xe60012);
  if (info.game) embed.setDescription(info.game);
  if (info.image) embed.setThumbnail(info.image);
  return embed;
}

// Erkennt unsere eigene Karte (gegen Endlosschleife beim Neu-Posten).
function isNpCard(message) {
  return (
    message.author?.id === client.user?.id &&
    message.embeds?.[0]?.author?.name === NP_AUTHOR
  );
}

// Karte ganz unten NEU posten (alte loeschen) -> bleibt immer letzte Nachricht.
async function restickNowPlaying(guildId) {
  const channel = npChannels.get(guildId);
  if (!channel || !npLast) return;
  try {
    const old = npMessages.get(guildId);
    if (old) await old.delete().catch(() => {});
    const msg = await channel.send({ embeds: [makeNpEmbed(npLast)] });
    npMessages.set(guildId, msg);
  } catch (err) {
    console.error("[nowplaying] Karte konnte nicht gepostet werden:", err.message);
  }
}

// Neu-Posten gebuendelt anstossen (falls mehrere Nachrichten schnell kommen).
function scheduleRestick(guildId) {
  clearTimeout(npRestickTimers.get(guildId));
  npRestickTimers.set(
    guildId,
    setTimeout(() => restickNowPlaying(guildId).catch(() => {}), 800)
  );
}

async function updateNowPlaying() {
  if (!browserHandle || npChannels.size === 0) return;
  const np = await browserHandle.nowPlaying();
  if (!np) return;

  const key = `${np.title}|${np.game}`;
  if (key === npLastKey) return; // nichts Neues
  npLastKey = key;
  npLast = np;

  // 1) Presence-Text ("Hoert <Titel>").
  client.user?.setActivity({
    name: np.game ? `${np.title} – ${np.game}` : np.title,
    type: ActivityType.Listening,
  });

  // 2) Karte bei Track-Wechsel in jedem aktiven Channel unten neu posten.
  for (const guildId of npChannels.keys()) {
    await restickNowPlaying(guildId);
  }
}

// Tracking fuer eine Guild beenden (letzte Karte stehen lassen).
function clearNowPlayingFor(guildId) {
  clearTimeout(npRestickTimers.get(guildId));
  npRestickTimers.delete(guildId);
  npChannels.delete(guildId);
  npMessages.delete(guildId);
  if (npChannels.size === 0) stopNowPlaying();
}

// --- FFmpeg-Aufnahme -------------------------------------------------------
// Liefert die plattformabhaengigen FFmpeg-Eingabeargumente.
//   Windows -> DirectShow vom VB-Cable ("CABLE Output …")
//   Linux   -> PulseAudio-Monitor des null-sinks ("<sink>.monitor")
function captureInputArgs() {
  if (process.platform === "win32") {
    return ["-f", "dshow", "-i", `audio=${config.audioDevice}`];
  }
  const sink = config.browser?.audioSink || "ntmusic";
  const source = config.audioSource || `${sink}.monitor`;
  return ["-f", "pulse", "-i", source];
}

function createCaptureResource(guildId) {
  // Vorhandenen Prozess fuer diese Guild beenden, falls vorhanden.
  stopCapture(guildId);

  const ff = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    // Live-Aufnahme vom virtuellen Audiogeraet (plattformabhaengig):
    ...captureInputArgs(),
    // In das von Discord erwartete Roh-PCM-Format wandeln:
    "-ac", "2",        // Stereo
    "-ar", "48000",    // 48 kHz
    "-f", "s16le",     // 16-Bit signed little-endian
    "pipe:1",
  ]);

  ff.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) console.error("[ffmpeg]", msg);
  });
  ff.on("error", (err) =>
    console.error("[ffmpeg] Prozessfehler:", err.message)
  );

  activeFfmpeg.set(guildId, ff);

  // StreamType.Raw = 48kHz, 16-Bit, Stereo PCM -> genau unser FFmpeg-Output.
  return createAudioResource(ff.stdout, { inputType: StreamType.Raw });
}

function stopCapture(guildId) {
  const ff = activeFfmpeg.get(guildId);
  if (ff) {
    ff.kill("SIGKILL");
    activeFfmpeg.delete(guildId);
  }
}

// --- Discord-Client --------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Bot betritt deinen Voice-Channel und streamt das Browser-Audio"),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Bot verlaesst den Voice-Channel und stoppt den Stream"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Zeigt, ob gerade gestreamt wird"),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Wiedergabe fortsetzen – oder mit Titel: suchen und abspielen")
    .addStringOption((o) =>
      o
        .setName("titel")
        .setDescription("Optional: Track suchen und abspielen")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Wiedergabe pausieren"),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Naechster Track"),
  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Wiederholung: ein Titel / alle / aus (ohne Auswahl: durchschalten)")
    .addStringOption((o) =>
      o
        .setName("modus")
        .setDescription("Wiederhol-Modus")
        .addChoices(
          { name: "Ein Titel", value: "one" },
          { name: "Alle", value: "all" },
          { name: "Aus", value: "stop" }
        )
    ),
  new SlashCommandBuilder()
    .setName("volumeup")
    .setDescription("Lauter (+10%)"),
  new SlashCommandBuilder()
    .setName("volumedown")
    .setDescription("Leiser (-10%)"),
  new SlashCommandBuilder()
    .setName("track")
    .setDescription("Track suchen und abspielen")
    .addStringOption((o) =>
      o.setName("name").setDescription("Suchbegriff").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Track suchen und als Naechstes einreihen")
    .addStringOption((o) =>
      o.setName("name").setDescription("Suchbegriff").setRequired(true)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(config.token);
  const appId = client.application.id;
  if (config.guildId && !config.guildId.startsWith("OPTIONAL")) {
    // Guild-Commands sind sofort verfuegbar (gut zum Testen).
    await rest.put(Routes.applicationGuildCommands(appId, config.guildId), {
      body: commands,
    });
    console.log("Slash-Commands fuer Guild", config.guildId, "registriert.");
  } else {
    // Globale Commands koennen bis zu ~1h brauchen, bis sie ueberall sind.
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    console.log("Globale Slash-Commands registriert (Verteilung kann dauern).");
  }
}

// Auf Linux/Pi den PulseAudio null-sink anlegen, falls noch nicht vorhanden.
function ensureLinuxSink() {
  if (process.platform === "win32" || !browserEnabled) return;
  const sink = browserCfg.audioSink || "ntmusic";
  try {
    const { execSync } = require("node:child_process");
    const sinks = execSync("pactl list short sinks", { encoding: "utf8" });
    if (!sinks.split(/\s+/).includes(sink)) {
      execSync(
        `pactl load-module module-null-sink sink_name=${sink} ` +
          `sink_properties=device.description=${sink}`
      );
      console.log(`[audio] PulseAudio null-sink "${sink}" angelegt.`);
    } else {
      console.log(`[audio] PulseAudio null-sink "${sink}" vorhanden.`);
    }
  } catch (err) {
    console.warn(
      "[audio] Konnte null-sink nicht anlegen (laeuft PulseAudio/pactl?):",
      err.message
    );
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Eingeloggt als ${c.user.tag}`);
  ensureLinuxSink();
  try {
    await registerCommands();
  } catch (err) {
    console.error("Konnte Slash-Commands nicht registrieren:", err);
  }
  console.log("Bereit. Tipp: /join in einem Voice-Channel ausfuehren.");
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    return interaction.reply({
      content: "Das geht nur auf einem Server, nicht in DMs.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const guildId = interaction.guildId;

  if (interaction.commandName === "status") {
    const playing = activeFfmpeg.has(guildId);
    return interaction.reply({
      content: playing ? "Streame gerade. 🎵" : "Streame gerade nichts.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // --- Player-Steuerung (benoetigt den laufenden Hintergrund-Browser) ------
  const playerCommands = new Set([
    "play",
    "pause",
    "skip",
    "loop",
    "volumeup",
    "volumedown",
    "track",
    "queue",
  ]);
  if (playerCommands.has(interaction.commandName)) {
    if (!browserEnabled) {
      return interaction.reply({
        content: "Browser-Steuerung ist aus (config.browser.enabled = false).",
        flags: MessageFlags.Ephemeral,
      });
    }
    const h = browserHandle;
    if (!h) {
      return interaction.reply({
        content: "Es laeuft nichts. Fuehr erst /join aus.",
        flags: MessageFlags.Ephemeral,
      });
    }
    // Sofort deferren: auf dem Pi koennen die page.evaluate-Aufrufe laenger als
    // die 3-Sekunden-Frist von Discord dauern ("Anwendung reagiert nicht").
    await interaction.deferReply();
    try {
      switch (interaction.commandName) {
        case "play": {
          const titel = interaction.options.getString("titel");
          if (titel) {
            // Mit Titel: suchen und abspielen (wie /track).
            const res = await h.search(titel);
            if (!res) {
              return interaction.editReply(
                `Nichts Abspielbares fuer **${titel}** gefunden.`
              );
            }
            return interaction.editReply({
              embeds: [trackEmbed("🔎 Spielt jetzt", res)],
            });
          }
          // Ohne Titel: nur fortsetzen.
          await h.play();
          return interaction.editReply("▶️ Weiter geht's.");
        }
        case "pause":
          await h.pause();
          return interaction.editReply("⏸️ Pausiert.");
        case "skip": {
          const ok = await h.next();
          return interaction.editReply(
            ok ? "⏭️ Naechster Track." : "Skip-Button nicht gefunden."
          );
        }
        case "loop": {
          const mode = interaction.options.getString("modus");
          if (mode) {
            const ok = await h.setLoop(mode);
            const label = {
              one: "🔂 Wiederhole **einen Titel**.",
              all: "🔁 Wiederhole **alle**.",
              stop: "➡️ Wiederholung **aus**.",
            }[mode];
            return interaction.editReply(
              ok
                ? label
                : "Konnte den Modus nicht setzen (Repeat-Button/Label pruefen, Log)."
            );
          }
          const ok = await h.cycleLoop();
          return interaction.editReply(
            ok ? "🔁 Wiederholung umgeschaltet." : "Loop-Button nicht gefunden."
          );
        }
        case "volumeup": {
          const v = await h.nudgeVolume(10);
          return interaction.editReply(`🔊 Lautstaerke: ${v}%`);
        }
        case "volumedown": {
          const v = await h.nudgeVolume(-10);
          return interaction.editReply(`🔉 Lautstaerke: ${v}%`);
        }
        case "track": {
          const q = interaction.options.getString("name", true);
          const res = await h.search(q);
          if (!res) {
            return interaction.editReply(
              `Nichts Abspielbares fuer **${q}** gefunden.`
            );
          }
          return interaction.editReply({
            embeds: [trackEmbed("🔎 Spielt jetzt", res)],
          });
        }
        case "queue": {
          const q = interaction.options.getString("name", true);
          const res = await h.queueNext(q);
          if (!res) {
            return interaction.editReply(
              `Nichts Einreihbares fuer **${q}** gefunden.`
            );
          }
          const content = res.loopSwitched
            ? "🔁 Wiederholung von *ein Titel* auf *alle* umgestellt."
            : undefined;
          return interaction.editReply({
            content,
            embeds: [trackEmbed("➕ Als Nächstes", res)],
          });
        }
      }
    } catch (err) {
      console.error("[player] Befehl fehlgeschlagen:", err);
      const msg = "Fehler bei der Steuerung. Details im Bot-Log.";
      return interaction.deferred
        ? interaction.editReply(msg)
        : interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.commandName === "leave") {
    const connection = getVoiceConnection(guildId);
    stopCapture(guildId);
    clearNowPlayingFor(guildId);
    stopBrowserIfIdle();
    if (connection) {
      connection.destroy();
      return interaction.reply("Channel verlassen, Stream gestoppt. 👋");
    }
    return interaction.reply({
      content: "Ich bin in keinem Voice-Channel.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.commandName === "join") {
    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: "Geh erst in einen Voice-Channel, dann /join.",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();

    try {
      // Hintergrund-Browser starten (falls aktiviert), damit Audio anliegt.
      if (browserEnabled) {
        try {
          await ensureBrowser();
        } catch (err) {
          console.error("[browser] Start fehlgeschlagen:", err);
          return interaction.editReply(
            "Konnte den Hintergrund-Browser nicht starten. Bist du bei " +
              "Nintendo Music eingeloggt? Einmal `npm run browser:login` " +
              "ausfuehren und einloggen. Details im Bot-Log."
          );
        }
      }

      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

      const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play },
      });

      player.on(AudioPlayerStatus.Idle, () => {
        if (getVoiceConnection(guildId)) {
          console.warn("Stream idle -> FFmpeg-Aufnahme wird neu gestartet.");
          player.play(createCaptureResource(guildId));
        }
      });
      player.on("error", (err) => console.error("[player]", err.message));

      connection.subscribe(player);
      player.play(createCaptureResource(guildId));

      // Now-Playing-Tracking fuer diesen Channel starten.
      if (browserEnabled) {
        npChannels.set(guildId, interaction.channel);
        startNowPlaying();
        updateNowPlaying().catch(() => {});
      }

      connection.on(VoiceConnectionStatus.Disconnected, () => {
        stopCapture(guildId);
        clearNowPlayingFor(guildId);
        stopBrowserIfIdle();
      });

      await interaction.editReply(
        `**${voiceChannel.name}** wurde beigetreten. 🎶`
      );
    } catch (err) {
      console.error("Join fehlgeschlagen:", err);
      stopCapture(guildId);
      getVoiceConnection(guildId)?.destroy();
      await interaction.editReply(
        "Konnte nicht beitreten / streamen. Details stehen im Bot-Log."
      );
    }
  }
});

// Sobald eine neue Nachricht im Now-Playing-Channel auftaucht, die Karte
// wieder nach ganz unten holen (ausser es ist die Karte selbst).
client.on(Events.MessageCreate, (message) => {
  const gid = message.guildId;
  if (!gid || !npChannels.has(gid)) return;
  if (message.channelId !== npChannels.get(gid).id) return;
  if (isNpCard(message)) return;
  scheduleRestick(gid);
});

// --- Sauberes Beenden ------------------------------------------------------
async function shutdown() {
  stopNowPlaying();
  for (const id of activeFfmpeg.keys()) stopCapture(id);
  await stopBrowser().catch(() => {});
  client.destroy();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.login(config.token);
