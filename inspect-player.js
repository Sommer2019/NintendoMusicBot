// ---------------------------------------------------------------------------
//  inspect-player.js
//  Diagnose-Tool: oeffnet Nintendo Music sichtbar (mit deinem Login-Profil)
//  und gibt auf ENTER alle Steuer-Elemente (Buttons + aria-label), Media-Status
//  und Suchfelder aus. Damit verdrahten wir /skip, /loop, /track exakt.
//
//  Start:   node inspect-player.js   (oder: npm run inspect)
//
//  Ablauf:
//    1. Warten, bis der Player geladen ist und etwas spielt.
//    2. Im Terminal ENTER druecken  -> DOM-Dump.
//    3. Player-Leiste (unten) im Bild haben, ggf. erneut ENTER fuer neuen Dump.
//    4. Die "=== BUTTONS ==="-Zeilen hierher kopieren.
//    5. Beenden mit STRG+C.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { startNintendoMusic } = require("./browser");

let browserCfg = {};
try {
  browserCfg =
    JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"))
      .browser ?? {};
} catch {
  // Defaults aus browser.js
}

(async () => {
  const { page } = await startNintendoMusic({ ...browserCfg, visible: true });

  console.log(
    "\nBrowser offen. Bring den Player in den gewuenschten Zustand,\n" +
      "dann ENTER fuer einen DOM-Dump. STRG+C zum Beenden.\n"
  );

  const dump = async () => {
    const data = await page.evaluate(() => {
      const out = { media: [], buttons: [], inputs: [] };

      document.querySelectorAll("audio, video").forEach((el, i) => {
        out.media.push({
          i,
          tag: el.tagName,
          paused: el.paused,
          vol: Number(el.volume.toFixed(2)),
          muted: el.muted,
          ct: Math.round(el.currentTime || 0),
          dur: Math.round(el.duration || 0),
        });
      });

      document.querySelectorAll('button, [role="button"]').forEach((b, i) => {
        const text = (b.innerText || "").trim().slice(0, 30);
        const aria = b.getAttribute("aria-label");
        const title = b.getAttribute("title");
        const tid = b.getAttribute("data-testid");
        const cls = (b.className || "").toString().slice(0, 45);
        if (text || aria || title || tid) {
          out.buttons.push({ i, text, aria, title, tid, cls });
        }
      });

      document.querySelectorAll('input, [role="searchbox"]').forEach((el, i) => {
        out.inputs.push({
          i,
          type: el.getAttribute("type"),
          ph: el.getAttribute("placeholder"),
          aria: el.getAttribute("aria-label"),
          role: el.getAttribute("role"),
        });
      });

      return out;
    });

    console.log("\n=== MEDIA ===");
    for (const m of data.media) console.log(JSON.stringify(m));

    console.log("=== BUTTONS ===");
    for (const b of data.buttons) {
      console.log(
        `#${b.i} text="${b.text}" aria="${b.aria ?? ""}" ` +
          `title="${b.title ?? ""}" testid="${b.tid ?? ""}" cls="${b.cls}"`
      );
    }

    console.log("=== INPUTS ===");
    for (const i of data.inputs) console.log(JSON.stringify(i));

    console.log("\nENTER fuer erneuten Dump. STRG+C zum Beenden.\n");
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.on("line", () => dump().catch((e) => console.error(e.message)));

  // Erster Dump nach kurzer Wartezeit (Player laedt).
  setTimeout(() => dump().catch((e) => console.error(e.message)), 6000);

  process.on("SIGINT", () => process.exit(0));
})().catch((err) => {
  console.error("Fehlgeschlagen:", err);
  process.exit(1);
});
