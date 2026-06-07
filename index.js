const fs = require("node:fs");
const path = require("node:path");
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

  if (browserCfg.enabled === false) {
	console.log("[start] Browser ist in config.json deaktiviert. Beende ohne Start.");
	return;
  }

  const visible = Boolean(browserCfg.visible);
  console.log(
	visible
	  ? "[start] Starte Nintendo Music sichtbar…"
	  : "[start] Starte Nintendo Music im Hintergrund…"
  );

  const controls = await startNintendoMusic({ ...browserCfg, visible });

  console.log("[start] Läuft. Beenden mit STRG+C.");

  const shutdown = async () => {
	console.log("\n[start] Beende…");
	try {
	  await controls.stop();
	} finally {
	  process.exit(0);
	}
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

module.exports = { main };
