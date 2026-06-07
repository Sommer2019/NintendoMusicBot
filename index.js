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
// Optionale Default-Playlist, die beim 24/7-Auto-Join nach (Neu-)Start laeuft.
const defaultPlaylist = browserCfg.defaultPlaylist || "";
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

// --- 24/7-Dauerbetrieb -----------------------------------------------------
// Persistenter Channel: per /stay gesetzt, beim Start automatisch betreten,
// bei Trennung automatisch wieder verbunden. Gespeichert in autojoin.json.
const autojoinPath = path.join(__dirname, "autojoin.json");
const persistentGuilds = new Set(); // guildIds, die 24/7 bleiben sollen

function loadAutojoin() {
  try {
    return JSON.parse(fs.readFileSync(autojoinPath, "utf8"));
  } catch {
    return null;
  }
}
function saveAutojoin(data) {
  try {
    fs.writeFileSync(autojoinPath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("[autojoin] Speichern fehlgeschlagen:", err.message);
  }
}
function clearAutojoin(guildId) {
  persistentGuilds.delete(guildId);
  const aj = loadAutojoin();
  if (aj && aj.guildId === guildId) {
    try {
      fs.unlinkSync(autojoinPath);
    } catch {
      /* egal */
    }
  }
}

// Gemeinsame Join-/Stream-Logik fuer /join, /stay und Auto-Join.
// Wirft bei Fehler (z. B. Browser-Start) -> Aufrufer faengt.
async function joinAndStream(guild, voiceChannel, textChannel) {
  const guildId = guild.id;
  if (browserEnabled) await ensureBrowser();

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });
  player.on(AudioPlayerStatus.Idle, () => {
    if (getVoiceConnection(guildId)) {
      player.play(createCaptureResource(guildId));
    }
  });
  player.on("error", (err) => console.error("[player]", err.message));
  connection.subscribe(player);
  player.play(createCaptureResource(guildId));

  // Channel fuer die "Spielt gerade"-Karte merken – aber NICHT starten.
  // Das Tracking beginnt erst, wenn wirklich etwas abgespielt wird (/play, /track).
  if (browserEnabled && textChannel) npChannels.set(guildId, textChannel);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    if (persistentGuilds.has(guildId)) {
      // 24/7: erst auf automatischen Reconnect warten, sonst neu beitreten.
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // verbindet sich selbst neu -> nichts tun
      } catch {
        try {
          connection.destroy();
        } catch {
          /* egal */
        }
        stopCapture(guildId);
        setTimeout(() => rejoinPersistent(guildId), 5_000);
      }
    } else {
      stopCapture(guildId);
      clearNowPlayingFor(guildId);
      stopBrowserIfIdle();
    }
  });

  return voiceChannel.name;
}

// Persistenten Channel (erneut) betreten – fuer Auto-Join beim Start und Rejoin.
// playDefault=true (nur beim Start): danach die Default-Playlist anspielen.
async function rejoinPersistent(guildId, playDefault = false) {
  const aj = loadAutojoin();
  if (!aj || aj.guildId !== guildId) return;
  try {
    const guild = await client.guilds.fetch(aj.guildId);
    const voiceChannel = await guild.channels.fetch(aj.channelId);
    const textChannel = aj.textChannelId
      ? await guild.channels.fetch(aj.textChannelId).catch(() => null)
      : null;
    await joinAndStream(guild, voiceChannel, textChannel);
    console.log(`[autojoin] Verbunden mit "${voiceChannel.name}".`);

    // Nach dem Start (nicht bei Reconnects) die Default-Playlist anspielen,
    // damit nach einem Neustart sofort Musik laeuft.
    if (playDefault && browserEnabled && defaultPlaylist && browserHandle) {
      startNowPlaying();
      try {
        await browserHandle.playPlaylist(defaultPlaylist);
        console.log(`[autojoin] Default-Playlist gestartet: "${defaultPlaylist}".`);
      } catch (err) {
        console.error("[autojoin] Default-Playlist fehlgeschlagen:", err.message);
      }
    }
  } catch (err) {
    console.error(
      "[autojoin] Rejoin fehlgeschlagen, neuer Versuch in 30s:",
      err.message
    );
    setTimeout(() => rejoinPersistent(guildId, playDefault), 30_000);
  }
}

// Beim Start den gespeicherten 24/7-Channel automatisch betreten + Default-Playlist.
async function autojoinOnStart() {
  const aj = loadAutojoin();
  if (!aj) return;
  persistentGuilds.add(aj.guildId);
  await rejoinPersistent(aj.guildId, true);
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
    .setName("stay")
    .setDescription("Bot bleibt dauerhaft (24/7) in deinem Voice-Channel"),
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
  new SlashCommandBuilder()
    .setName("playlist")
    .setDescription("Playlist suchen und abspielen")
    .addStringOption((o) =>
      o.setName("name").setDescription("Playlist-Name").setRequired(true)
    ),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(config.token);
  const appId = client.application.id;

  if (config.guildId && !config.guildId.startsWith("OPTIONAL")) {
    // Fester Test-Server: Guild-Commands, sofort verfuegbar.
    await rest.put(Routes.applicationGuildCommands(appId, config.guildId), {
      body: commands,
    });
    console.log("Slash-Commands fuer Guild", config.guildId, "registriert.");
    return;
  }

  // Kein fester guildId -> in JEDEN aktuellen Server direkt registrieren.
  // Guild-Commands erscheinen SOFORT (globale braeuchten bis zu ~1 h).
  // Alte globale Commands entfernen, damit keine Duplikate entstehen.
  await rest.put(Routes.applicationCommands(appId), { body: [] }).catch(() => {});

  const guilds = await client.guilds.fetch();
  let ok = 0;
  for (const [gid] of guilds) {
    try {
      await rest.put(Routes.applicationGuildCommands(appId, gid), {
        body: commands,
      });
      ok++;
    } catch (err) {
      console.error(`Command-Registrierung fuer Guild ${gid}:`, err.message);
    }
  }
  console.log(`Slash-Commands fuer ${ok} Server registriert (sofort verfuegbar).`);
}

// Tritt der Bot einem neuen Server bei, dort die Commands sofort registrieren.
client.on(Events.GuildCreate, async (guild) => {
  if (config.guildId && !config.guildId.startsWith("OPTIONAL")) return;
  try {
    const rest = new REST({ version: "10" }).setToken(config.token);
    await rest.put(
      Routes.applicationGuildCommands(client.application.id, guild.id),
      { body: commands }
    );
    console.log(`Slash-Commands fuer neuen Server "${guild.name}" registriert.`);
  } catch (err) {
    console.error("Command-Registrierung (GuildCreate):", err.message);
  }
});

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
  // Falls ein 24/7-Channel gesetzt ist (/stay), automatisch betreten.
  autojoinOnStart().catch((err) =>
    console.error("[autojoin] Start-Join fehlgeschlagen:", err.message)
  );
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
    "playlist",
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
    // "Spielt gerade"-Tracking erst hier starten (nicht schon bei /join). Die
    // Karte erscheint ohnehin nur, sobald wirklich ein Track laeuft.
    startNowPlaying();
    // Diagnose: kurz nach einem Play-Befehl den Media-Status loggen.
    if (["play", "track", "playlist"].includes(interaction.commandName)) {
      setTimeout(() => h.diag().catch(() => {}), 6000);
    }
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
        case "playlist": {
          const q = interaction.options.getString("name", true);
          const title = await h.playPlaylist(q);
          return interaction.editReply(
            title
              ? `📃 Spiele Playlist **${title}**.`
              : `Playlist **${q}** nicht gefunden oder nicht abspielbar.`
          );
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
    clearAutojoin(guildId); // 24/7-Modus beenden, sonst Auto-Rejoin
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

  if (interaction.commandName === "join" || interaction.commandName === "stay") {
    const stay = interaction.commandName === "stay";
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: `Geh erst in einen Voice-Channel, dann /${interaction.commandName}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();

    try {
      if (stay) {
        // 24/7 merken (auch fuer Auto-Join nach Neustart) BEVOR wir joinen,
        // damit der Disconnect-Handler den Rejoin uebernimmt.
        persistentGuilds.add(guildId);
        saveAutojoin({
          guildId,
          channelId: voiceChannel.id,
          textChannelId: interaction.channel?.id ?? null,
        });
      }

      await joinAndStream(interaction.guild, voiceChannel, interaction.channel);

      await interaction.editReply(
        stay
          ? `📌 Bleibe jetzt **24/7** in **${voiceChannel.name}** (auch nach Neustart). 🎶`
          : `**${voiceChannel.name}** wurde beigetreten. 🎶`
      );
    } catch (err) {
      console.error(`${interaction.commandName} fehlgeschlagen:`, err);
      if (stay) clearAutojoin(guildId);
      stopCapture(guildId);
      getVoiceConnection(guildId)?.destroy();
      // Browser-Start-Fehler gesondert melden (haeufigste Ursache: kein Login).
      const browserIssue = /playwright|chromium|widevine|executablePath/i.test(
        err?.message || ""
      );
      await interaction.editReply(
        browserIssue
          ? "Konnte den Hintergrund-Browser nicht starten. Eingeloggt? " +
              "Einmal `npm run browser:login`. Details im Bot-Log."
          : "Konnte nicht beitreten / streamen. Details stehen im Bot-Log."
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
