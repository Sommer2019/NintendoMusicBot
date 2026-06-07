// ---------------------------------------------------------------------------
//  test-browser.js
//  Testet browser.js ISOLIERT (ohne Discord-Bot).
//
//  Erster Lauf (einloggen):   node test-browser.js --visible
//    -> sichtbares Fenster, manuell bei Nintendo Music einloggen,
//       Wiedergabe pruefen. Login wird im Profil gespeichert.
//
//  Danach (Hintergrund):      node test-browser.js
//    -> Fenster versteckt, sollte automatisch weiterspielen.
//
//  Beenden mit STRG+C.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const { startNintendoMusic } = require("./browser");

const visible = process.argv.includes("--visible");

// browser-Optionen aus config.json lesen (executablePath/audioSink fuer Linux).
let browserCfg = {};
try {
  const cfgPath = path.join(__dirname, "config.json");
  browserCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")).browser ?? {};
} catch {
  // ohne config.json laufen die Defaults aus browser.js
}

(async () => {
  console.log(
    visible
      ? "Starte SICHTBAR – zum Einloggen / Selektor pruefen."
      : "Starte VERSTECKT – Hintergrundbetrieb."
  );

  const { stop } = await startNintendoMusic({ ...browserCfg, visible });

  console.log(
    "Laeuft. Pruefe, ob im Voice/VB-Cable Ton ankommt. Beenden mit STRG+C."
  );

  const shutdown = async () => {
    console.log("\nBeende…");
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})().catch((err) => {
  console.error("Fehlgeschlagen:", err);
  process.exit(1);
});
