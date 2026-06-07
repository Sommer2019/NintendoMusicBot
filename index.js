const fs = require("node:fs");
const path = require("node:path");
const { startDiscordBot } = require("./bot");
const { startNintendoMusic } = require("./browser");

function loadConfig() {
  try {
    const cfgPath = path.join(__dirname, "config.json");
    return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const cfg = loadConfig();
  const browserCfg = cfg.browser ?? {};
  const shutdownSteps = [];
  let browserControls = null;

  if (cfg.token) {
    console.log("[start] Starte Discord-Bot…");
    try {
      const bot = await startDiscordBot(
        { token: cfg.token, guildId: cfg.guildId },
        () => browserControls
      );
      if (bot) {
        shutdownSteps.push(bot.stop);
      }
    } catch (err) {
      console.error("[start] Discord-Bot konnte nicht gestartet werden:", err.message);
    }
  } else {
    console.warn("[start] Kein token in config.json – Discord-Bot wird nicht gestartet.");
  }

  if (browserCfg.enabled !== false) {
    const visible = Boolean(browserCfg.visible);
    console.log(
      visible
        ? "[start] Starte Nintendo Music sichtbar…"
        : "[start] Starte Nintendo Music im Hintergrund…"
    );

    try {
      browserControls = await startNintendoMusic({ ...browserCfg, visible });
      shutdownSteps.push(browserControls.stop);
    } catch (err) {
      console.error("[start] Browser konnte nicht gestartet werden:", err.message);
    }
  } else {
    console.log("[start] Browser ist in config.json deaktiviert.");
  }

  console.log("[start] Läuft. Beenden mit STRG+C.");

  const shutdown = async () => {
    console.log("\n[start] Beende…");
    while (shutdownSteps.length) {
      const stop = shutdownSteps.pop();
      try {
        await stop();
      } catch (err) {
        console.error("[start] Fehler beim Beenden:", err.message);
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[start] Fehlgeschlagen:", err);
    process.exit(1);
  });
}

module.exports = { main, loadConfig };
