// ---------------------------------------------------------------------------
//  browser.js  (cross-platform: Windows + Linux/Raspberry Pi)
//  Startet eine ECHTE Chrome/Chromium-Engine (mit Widevine) im Hintergrund,
//  loggt sich per persistentem Profil bei Nintendo Music ein, startet die
//  Wiedergabe und routet den Ton aufs virtuelle Audiogeraet.
//
//  Plattformen:
//    Windows: channel "chrome" (Google Chrome) + SoundVolumeView routet den
//             Ton auf "CABLE Input" (VB-Audio Virtual Cable).
//    Linux:   System-Chromium via executablePath + PULSE_SINK leitet den Ton
//             direkt in einen PulseAudio null-sink (kein Nachfassen noetig).
//             Auf einem headless Pi via "xvfb-run" starten.
//
//  Wichtig / ehrliche Grenzen:
//    - Voll-headless + Widevine ist unzuverlaessig -> wir starten "headed"
//      (Fenster aus dem Bild geschoben bzw. in Xvfb).
//    - Linux: Playwrights Bundle-Chromium hat KEIN Widevine -> executablePath
//      auf das System-Chromium setzen (sonst DRM-Fehler 9012-5401).
//
//  Einmalig: Mit sichtbarem Fenster starten und manuell einloggen
//            -> das Profil (chrome-profile/) merkt sich den Login.
// ---------------------------------------------------------------------------

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  throw new Error(
    "playwright fehlt. Installiere es mit:\n" +
      "  npm i playwright\n" +
      "  npx playwright install chrome"
  );
}

const IS_WIN = process.platform === "win32";
let xvfbProcess = null;

const LINUX_CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  // Auf Debian/amd64 ist Google Chrome die zuverlaessigste Widevine-Quelle:
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/opt/google/chrome/chrome",
  // Chromium-Varianten (Debian/Ubuntu/Raspberry Pi OS, snap):
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];

function resolveLinuxChromiumExecutable(explicitPath = "") {
  const candidates = [explicitPath, ...LINUX_CHROMIUM_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

const DEFAULTS = {
  // Profilordner, in dem der Nintendo-Login persistiert wird.
  userDataDir: path.join(__dirname, "chrome-profile"),
  // Startseite von Nintendo Music.
  url: "https://music.nintendo.com/de-DE/",
  // true  = Fenster sichtbar (zum Einloggen / Debuggen)
  // false = Fenster aus dem Bild schieben ("unsichtbar")
  visible: false,

  // --- Windows: VB-Cable + SoundVolumeView -------------------------------
  cableInputName: "CABLE Input",
  soundVolumeViewPath: path.join(__dirname, "SoundVolumeView.exe"),

  // --- Linux/Pi: System-Chromium + PulseAudio ----------------------------
  // Pfad zum Chromium MIT Widevine (Playwrights Bundle hat KEIN Widevine!).
  // Auf Raspberry Pi OS i. d. R. /usr/bin/chromium-browser bzw. /usr/bin/chromium.
  executablePath: "",
  // Name des PulseAudio null-sinks, in den Chromium ausgibt (per PULSE_SINK).
  audioSink: "ntmusic",
};

/**
 * Startet Chrome, oeffnet Nintendo Music und versucht, die Wiedergabe zu
 * starten. Gibt { ctx, page, stop } zurueck.
 *
 * @param {Partial<typeof DEFAULTS>} [options]
 */
async function startNintendoMusic(options = {}) {
  const cfg = { ...DEFAULTS, ...options };

  const args = ["--autoplay-policy=no-user-gesture-required"];
  if (!cfg.visible) {
    // Fenster weit aus dem sichtbaren Bereich schieben.
    args.push("--window-position=-32000,-32000");
  }

  const launchOpts = {
    headless: false, // headless + Widevine = unzuverlaessig
    // WICHTIG fuer DRM: Playwright setzt standardmaessig
    // "--disable-component-update", wodurch das Widevine-CDM nie geladen wird
    // (-> Fehler 9012-5401 "Track kann nicht abgespielt werden").
    ignoreDefaultArgs: ["--disable-component-update"],
    args,
  };

  let displaySetup = { display: "", startedXvfb: false };
  if (IS_WIN) {
    // Windows: echtes Google Chrome -> Widevine-CDM vorhanden.
    launchOpts.channel = "chrome";
  } else {
    displaySetup = await ensureLinuxDisplay();
    // Linux/Pi: System-Chromium MIT Widevine (Playwright-Bundle hat keins).
    const chromiumPath = resolveLinuxChromiumExecutable(cfg.executablePath);
    if (chromiumPath) {
      launchOpts.executablePath = chromiumPath;
      if (!cfg.executablePath) {
        console.log(`[browser] Nutze System-Chromium: ${chromiumPath}`);
      }
    } else {
      console.warn(
        "[browser] Kein System-Chromium gefunden. Playwrights Bundle-Chromium\n" +
          "          hat KEIN Widevine. Setze browser.executablePath in config.json\n" +
          "          auf ein vorhandenes Chromium, z. B. /usr/bin/chromium-browser\n" +
          "          oder /usr/bin/chromium."
      );
    }
    // Chromium-Audio in den PulseAudio/PipeWire null-sink leiten.
    // WICHTIG: Laeuft der Bot als Dienst, fehlen oft XDG_RUNTIME_DIR/PULSE_SERVER
    // -> Chromium findet den Audio-Socket nicht und gibt KEINEN Ton aus
    // (Track spielt, aber kein sink-input). Wir leiten beide explizit aus der
    // UID ab, damit Chromium den User-Socket immer trifft.
    const uid =
      typeof process.getuid === "function" ? process.getuid() : 1000;
    const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
    const pulseServer =
      process.env.PULSE_SERVER || `unix:${runtimeDir}/pulse/native`;
    console.log(
      `[browser] Audio-Env: XDG_RUNTIME_DIR=${runtimeDir} PULSE_SERVER=${pulseServer} PULSE_SINK=${cfg.audioSink}`
    );
    launchOpts.env = {
      ...process.env,
      ...(displaySetup.display ? { DISPLAY: displaySetup.display } : {}),
      XDG_RUNTIME_DIR: runtimeDir,
      PULSE_SERVER: pulseServer,
      PULSE_SINK: cfg.audioSink,
    };
  }

  if (displaySetup.startedXvfb) {
    console.log(`[browser] Kein DISPLAY gefunden – nutze Xvfb ${displaySetup.display}.`);
  }

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(cfg.userDataDir, launchOpts);
  } catch (err) {
    await stopXvfb();
    throw err;
  }
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  console.log("[browser] Oeffne", cfg.url);
  await page.goto(cfg.url, { waitUntil: "domcontentloaded" });

  // Schliesst ggf. offene Modals/Dialoge (z.B. "Schließen"-Button auf Startseite).
  try {
    await page.waitForTimeout(10000);
  } catch {
    // ignore
  }
  await tryCloseModals(page);

  // Kein Auto-Play beim Start: Ohne gespeicherte Queue gibt es nichts
  // abzuspielen. Die Wiedergabe wird gezielt per /play <titel> bzw. /track
  // gestartet (siehe controls.search).

  // Audio-Routing:
  //   Linux/Pi -> bereits ueber PULSE_SINK beim Start erledigt, nichts zu tun.
  //   Windows  -> SoundVolumeView wiederholt anwenden, da die Chrome-Audio-
  //               Session erst mit der Wiedergabe entsteht. /SetAppDefault ist
  //               idempotent und verschiebt auch eine laufende Session.
  let fastTimer = null;
  let routeTimer = null;
  if (IS_WIN) {
    routeChromeAudioToCable(cfg);
    // Erste ~6 s schnell routen, um das kurze Aufblitzen auf den PC-Boxen zu
    // minimieren; danach nur noch gelegentlich nachfassen.
    let burst = 0;
    fastTimer = setInterval(() => {
      routeChromeAudioToCable(cfg, true);
      if (++burst >= 12) clearInterval(fastTimer);
    }, 500);
    routeTimer = setInterval(() => routeChromeAudioToCable(cfg, true), 5000);
  }

  const stop = async () => {
    if (fastTimer) clearInterval(fastTimer);
    if (routeTimer) clearInterval(routeTimer);
    try {
      await ctx.close();
    } catch (err) {
      console.error("[browser] Fehler beim Schliessen:", err.message);
    }
    await stopXvfb();
  };

  // Lautstaerke 0..1 merken (Media-Element-Volume, unabhaengig vom System).
  let volume = 1;

  return {
    ctx,
    page,
    stop,

    play: () => mediaPlay(page),
    pause: () => mediaPause(page),
    // Exakte aria-labels aus der Player-Leiste (class-Namen sind gehasht).
    next: () => clickAria(page, ["Nächster Track"]),
    prev: () => clickAria(page, ["Vorheriger Track"]),
    // Repeat: einmal durchschalten (aus -> alle -> einer -> aus).
    cycleLoop: () => cycleLoop(page),
    // Repeat gezielt setzen: "one" | "all" | "stop".
    setLoop: (mode) => setLoopMode(page, mode),

    /** Lautstaerke in Prozent (0..100) setzen. Gibt den neuen Wert zurueck. */
    setVolume: async (pct) => {
      volume = Math.max(0, Math.min(1, pct / 100));
      await setMediaVolume(page, volume);
      return Math.round(volume * 100);
    },
    /** Lautstaerke relativ aendern (z. B. +10 / -10). */
    nudgeVolume: async (deltaPct) => {
      volume = Math.max(0, Math.min(1, volume + deltaPct / 100));
      await setMediaVolume(page, volume);
      return Math.round(volume * 100);
    },
    getVolume: () => Math.round(volume * 100),

    /** Track suchen und ersten Treffer abspielen. */
    search: (query) => searchAndPlay(page, query),

    /** Track suchen und als Naechstes einreihen. */
    queueNext: (query) => queueNext(page, query),

    /** Playlist suchen und abspielen. */
    playPlaylist: (query) => playPlaylist(page, query),

    /** Aktuell laufenden Titel auslesen: { title, game, image } | null. */
    nowPlaying: () => getNowPlaying(page),

    /** Diagnose: Media-/DRM-Status ins Log schreiben. */
    diag: () => logMediaDiagnostics(page),
  };
}

async function ensureLinuxDisplay() {
  if (IS_WIN || process.env.DISPLAY) {
    return { display: process.env.DISPLAY ?? "", startedXvfb: false };
  }

  const display = process.env.DCNM_XVFB_DISPLAY || ":99";
  const socketPath = `/tmp/.X11-unix/X${display.replace(/^:/, "")}`;

  if (xvfbProcess) {
    return { display, startedXvfb: true };
  }

  xvfbProcess = spawn("Xvfb", [display, "-screen", "0", "1280x720x24", "-ac", "-nolisten", "tcp"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  xvfbProcess.stderr?.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) console.warn(`[browser] Xvfb: ${msg}`);
  });

  xvfbProcess.on("error", (err) => {
    console.error("[browser] Xvfb konnte nicht gestartet werden:", err.message);
  });

  await waitForFile(socketPath, 3000).catch(async () => {
    await stopXvfb();
    throw new Error(
      "Xvfb wurde nicht rechtzeitig bereit. Stelle sicher, dass das Paket 'xvfb' installiert ist."
    );
  });

  return { display, startedXvfb: true };
}

async function stopXvfb() {
  if (!xvfbProcess) return;
  const proc = xvfbProcess;
  xvfbProcess = null;
  try {
    proc.kill();
  } catch {
    // ignorieren
  }
}

async function waitForFile(filePath, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

/**
 * Sucht nach Close-Buttons (Schließen, Dismiss, etc.) und klickt sie,
 * damit ggf. verdeckte UI-Elemente sichtbar werden.
 */
async function tryCloseModals(page) {
  const result = await page.evaluate(() => {
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        style.opacity !== "0" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const norm = (s) => (s || "").toLowerCase().trim();

    // Suche nach Close-Buttons anhand Text / aria-label / title.
    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"], [role="dialog"] button')
    ).filter((el) => {
      const label = norm(el.getAttribute("aria-label"));
      const title = norm(el.getAttribute("title"));
      const text = norm(el.textContent);
      const match = /schließ|schliessen|schließen|schliess|close|dismiss|zurück|back|exit/.test(
        label || title || text
      );
      return match && isVisible(el);
    });

    const closed = [];
    for (const el of candidates) {
      try {
        el.scrollIntoView({ block: "center", inline: "center" });
        el.click();
        closed.push(
          `${el.tagName.toLowerCase()}[aria-label="${el.getAttribute("aria-label") || ""}"]`
        );
      } catch {
        // naechster
      }
    }
    return closed;
  });

  if (result.length > 0) {
    console.log(`[browser] Modal(s) geschlossen: ${result.join(", ")}`);
  }
}

/**
 * Versucht ueber mehrere Strategien, einen Play-Button zu finden und zu
 * klicken. Wirft NICHT – meldet nur, falls nichts gefunden wurde (die echte
 * UI/Selektoren musst du am DOM verifizieren).
 */
async function clickFirstVisibleMatch(locator, timeout = 1200) {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const loc = locator.nth(i);
    try {
      await loc.waitFor({ state: "visible", timeout });
      await loc.click();
      return true;
    } catch {
      // naechster Treffer
    }
  }
  return false;
}

async function tryStartPlayback(page) {
  const strategies = [
    page.locator('button[aria-label="Abspielen"]'),
    page.getByRole("button", { name: /^abspielen$/i }),
    page.getByRole("button", { name: /abspielen|wiedergabe|play/i }),
    page.getByText(/^abspielen$/i),
    page.locator('button[aria-label*="abspielen" i]'),
    page.locator('button[aria-label*="play" i]'),
    page.locator('[data-testid*="play" i]'),
    page.locator('button:has(svg[class*="play" i])'),
  ];

  for (const loc of strategies) {
    if (await clickFirstVisibleMatch(loc)) {
      // Kleine Verzögerung, damit die Wiedergabe bzw. die Audio-Session
      // Zeit hat, sich zu initialisieren (verhindert, dass direkte
      // Folgeaktionen die noch nicht vorhandene Session verfehlen).
      try {
        await page.waitForTimeout(800);
      } catch {
        // ignore
      }
      console.log("[browser] Wiedergabe gestartet.");
      return true;
    }
  }

  console.warn(
    "[browser] Kein Play-Button automatisch gefunden. Sichtbare Buttons:"
  );
  await dumpButtons(page);
  return false;
}

// --- Player-Steuerung -------------------------------------------------------

/** Setzt die Lautstaerke (0..1) auf allen Media-Elementen der Seite. */
async function setMediaVolume(page, vol) {
  return page.evaluate((v) => {
    let applied = null;
    document.querySelectorAll("audio, video").forEach((el) => {
      el.muted = false;
      el.volume = v;
      applied = v;
    });
    return applied;
  }, vol);
}

/** Startet die Wiedergabe ueber das Media-Element, sonst per UI-Klick. */
async function mediaPlay(page) {
  const ok = await page.evaluate(async () => {
    const el = document.querySelector("audio, video");
    if (!el) return false;
    try {
      await el.play();
      return true;
    } catch {
      return false;
    }
  });
  if (!ok) return clickControl(page, [/abspielen|wiedergabe|^play$/i]);
  return true;
}

/** Pausiert ueber das Media-Element, sonst per UI-Klick. */
async function mediaPause(page) {
  const ok = await page.evaluate(() => {
    const el = document.querySelector("audio, video");
    if (!el) return false;
    el.pause();
    return true;
  });
  if (!ok) return clickControl(page, [/pause|pausieren/i]);
  return true;
}

// --- Now Playing ------------------------------------------------------------
// Liest den "Gerade laeuft"-Block aus (stabiler Anker: aria-label, class
// gehasht). Liefert { title, game, image } oder null.
async function getNowPlaying(page) {
  try {
    return await page.evaluate(() => {
      const root = document.querySelector(
        '[role="group"][aria-label="Gerade läuft"]'
      );
      if (!root) return null;

      const img = root.querySelector("img");
      const image = img ? img.getAttribute("src") : null;

      // Titel = erstes sichtbares span, das NICHT in einem <a> steckt.
      const spans = Array.from(
        root.querySelectorAll('span[aria-hidden="false"]')
      );
      const title = (
        spans.find((s) => !s.closest("a"))?.textContent || ""
      ).trim();
      // Spiel/Album = sichtbares span innerhalb des <a>.
      const game = (
        root.querySelector('a span[aria-hidden="false"]')?.textContent || ""
      ).trim();

      if (!title) return null;
      return { title, game, image };
    });
  } catch {
    return null;
  }
}

// Diagnose-Ausgabe: Media-Element-Status + moeglicher DRM-Fehler im DOM.
async function logMediaDiagnostics(page) {
  const s = await page.evaluate(() => {
    const el = document.querySelector("audio, video");
    const txt = document.body ? document.body.innerText || "" : "";
    const drm = /9012-|kann nicht abgespielt|cannot be played|wiedergegeben werden/i.test(
      txt
    );
    return {
      hasMediaEl: !!el,
      paused: el ? el.paused : null,
      currentTime: el ? Math.round(el.currentTime || 0) : null,
      readyState: el ? el.readyState : null, // 4 = genug Daten zum Abspielen
      muted: el ? el.muted : null,
      volume: el ? el.volume : null,
      drmErrorVisible: drm,
    };
  });
  console.log("[browser][diag] Media:", JSON.stringify(s));
  if (s.drmErrorVisible) {
    console.warn(
      "[browser][diag] DRM-Fehler im DOM erkannt -> Widevine spielt nicht " +
        "(ARM/Chromium). Das ist die Ursache fuer 'kein Ton'."
    );
  } else if (s.hasMediaEl && s.paused) {
    console.warn(
      "[browser][diag] Media-Element ist PAUSIERT -> Wiedergabe lief nicht an " +
        "(Play-Button/Autoplay?)."
    );
  } else if (s.hasMediaEl && !s.paused && s.currentTime > 0) {
    console.log(
      "[browser][diag] Audio LAEUFT (currentTime steigt) -> Problem liegt im " +
        "Audio-Routing (Chromium -> PulseAudio/ntmusic), nicht an DRM."
    );
  } else if (!s.hasMediaEl) {
    console.warn(
      "[browser][diag] KEIN <audio>/<video>-Element gefunden -> Seite/Player " +
        "nicht korrekt geladen."
    );
  }
}

// --- Repeat / Loop ----------------------------------------------------------
// Der Repeat-Button traegt "…wiederhol…" im aria-label und aendert es je nach
// Zustand. Wir erkennen den Zustand per Schluesselwort und klicken so oft, bis
// der Ziel-Modus erreicht ist. (Selektor ueber Teilstring, da class gehasht.)
const REPEAT_SEL = 'button[aria-label*="iederhol" i]';

/**
 * Ordnet das aria-label dem AKTUELLEN Modus zu: "stop" | "all" | "one" | null.
 *
 * Wichtig: Nintendos aria-label beschreibt die AKTION des naechsten Klicks,
 * nicht den Ist-Zustand. Daraus leiten wir den aktuellen Modus ab:
 *   "…Wiederholen aktivieren"                  -> aktuell: aus    (Klick = alle)
 *   "…Wiederholen fuer einzelnen Track aktivieren" -> aktuell: alle (Klick = einer)
 *   "…Wiederholen deaktivieren"                -> aktuell: einer  (Klick = aus)
 * Reihenfolge zwingend: "deaktivieren" enthaelt "aktivieren" als Teilstring,
 * daher zuerst pruefen.
 */
function classifyLoop(label) {
  const s = (label || "").toLowerCase();
  if (s.includes("deaktivieren")) return "one";
  if (/einzeln|track/.test(s)) return "all";
  if (s.includes("aktivieren")) return "stop";
  return null;
}

/** Liest den Repeat-Button + aktuellen Modus. */
async function readLoop(page) {
  const loc = page.locator(REPEAT_SEL).first();
  try {
    await loc.waitFor({ state: "visible", timeout: 2000 });
    const label = await loc.getAttribute("aria-label");
    return { loc, label, mode: classifyLoop(label) };
  } catch {
    return { loc: null, label: null, mode: null };
  }
}

/** Schaltet den Repeat-Modus einmal weiter. */
async function cycleLoop(page) {
  const cur = await readLoop(page);
  if (!cur.loc) {
    console.warn("[browser] Repeat-Button nicht gefunden.");
    return false;
  }
  await cur.loc.click();
  return true;
}

/** Setzt gezielt einen Repeat-Modus, indem mehrfach durchgeschaltet wird. */
async function setLoopMode(page, target) {
  for (let i = 0; i < 4; i++) {
    const cur = await readLoop(page);
    if (!cur.loc) {
      console.warn("[browser] Repeat-Button nicht gefunden.");
      return false;
    }
    if (cur.mode === target) return true;
    if (cur.mode === null) {
      console.warn(
        `[browser] Loop-Zustand unklar, aria-label="${cur.label}" – ` +
          "bitte dieses Label melden, dann verdrahte ich es exakt."
      );
    }
    await cur.loc.click();
    await page.waitForTimeout(300);
  }
  const after = await readLoop(page);
  return after.mode === target;
}

/**
 * Klickt einen Button anhand exaktem aria-label (stabil, da class-Namen
 * gehasht sind). Probiert mehrere Label-Kandidaten. Gibt true/false zurueck.
 */
async function clickAria(page, labels, timeout = 2500) {
  for (const label of labels) {
    try {
      const loc = page.locator(`button[aria-label="${label}"]`).first();
      await loc.waitFor({ state: "visible", timeout });
      await loc.click();
      return true;
    } catch {
      // naechster Kandidat
    }
  }
  return false;
}

/**
 * Versucht, einen Button anhand mehrerer Namens-Regexes zu klicken
 * (accessible name = Text ODER aria-label). Gibt true/false zurueck.
 */
async function clickControl(page, namePatterns, timeout = 2500) {
  for (const pat of namePatterns) {
    try {
      const loc = page.getByRole("button", { name: pat }).first();
      await loc.waitFor({ state: "visible", timeout });
      await loc.click();
      return true;
    } catch {
      // naechstes Muster
    }
  }
  console.warn("[browser] Steuer-Button nicht gefunden fuer:", String(namePatterns[0]));
  return false;
}

// Such-UI von Nintendo Music (verifiziert am DOM):
//   - Suchfeld:  #search-box-input  (role="combobox")
//   - Enter ->   Ergebnisseite  #results-panel
//   - Track  =   div[role="button"] (class _1oc9kqg0) mit Play-Overlay + ⋮-Menue
//   - Spiel/Playlist = <a href="/…/game|playlist/…">  (Links -> ignorieren)
//   - keine Treffer: Text "Nichts gefunden"

/**
 * Tippt den Suchbegriff ein und oeffnet die Ergebnisseite.
 * Gibt true zurueck, wenn Treffer da sind, sonst false.
 */
async function performSearch(page, query) {
  const input = page.locator("#search-box-input");
  try {
    await input.waitFor({ state: "visible", timeout: 4000 });
  } catch {
    await clickAria(page, ["Inhalte durchsuchen", "Suchen", "Suche"]);
    try {
      await input.waitFor({ state: "visible", timeout: 4000 });
    } catch {
      console.warn("[browser] Suchfeld (#search-box-input) nicht gefunden.");
      return false;
    }
  }

  await input.click();
  await input.fill(query);
  await input.press("Enter");

  try {
    await page.waitForFunction(
      () =>
        document.querySelector("#results-panel") ||
        Array.from(document.querySelectorAll("p")).some((p) =>
          /nichts gefunden/i.test(p.textContent || "")
        ),
      { timeout: 6000 }
    );
  } catch {
    // weiter – Treffer wird unten ohnehin geprueft
  }

  const nothing = await page
    .getByText(/nichts gefunden/i)
    .count()
    .catch(() => 0);
  if (nothing) {
    console.warn(`[browser] Suche "${query}": Nichts gefunden.`);
    return false;
  }
  return true;
}

/** Erste echte Track-Karte im Ergebnis (kein Spiel/Playlist-Link). */
function firstTrackCard(page) {
  return page.locator('#results-panel div[role="button"]').first();
}

/** Liest Titel, Spiel und Bild-URL aus einer Track-Karte. */
async function readCardInfo(card) {
  return card.evaluate((el) => {
    const ps = el.querySelectorAll("p");
    const title = (ps[0]?.textContent || "").trim();
    // Untertitel ist z. B. "Track ・ Mario Kart 8 Deluxe" -> Spielname extrahieren.
    const game = (ps[1]?.textContent || "").replace(/^.*?・\s*/, "").trim();
    const img = el.querySelector("img");
    const image = img ? img.getAttribute("src") : null;
    return { title, game, image };
  });
}

/** Sucht einen Track und spielt den ersten TRACK-Treffer ab. */
async function searchAndPlay(page, query) {
  if (!(await performSearch(page, query))) return false;

  const card = firstTrackCard(page);
  try {
    await card.waitFor({ state: "visible", timeout: 5000 });
    const info = await readCardInfo(card);
    await card.click();
    console.log(`[browser] Suche "${query}" -> spiele "${info.title}".`);
    return info;
  } catch {
    console.warn(
      `[browser] Suche "${query}": kein abspielbarer Track ` +
        "(evtl. nur Spiele/Playlists gefunden)."
    );
    return false;
  }
}

/**
 * Sucht einen Track und reiht ihn als Naechstes ein:
 * erste Track-Karte -> ⋮ "Menü öffnen" -> "Als Nächstes wiedergeben".
 */
async function queueNext(page, query) {
  if (!(await performSearch(page, query))) return false;

  const card = firstTrackCard(page);
  try {
    await card.waitFor({ state: "visible", timeout: 5000 });
    const info = await readCardInfo(card);

    // ⋮-Button ist teils erst bei Hover sichtbar.
    await card.hover();
    await card.locator('button[aria-label="Menü öffnen"]').first().click();

    const item = page
      .getByRole("menuitem", { name: /als n(ä|ae)chstes wiedergeben/i })
      .first();
    await item.waitFor({ state: "visible", timeout: 3000 });
    await item.click();

    // Wird gerade EIN Titel wiederholt, kommt der eingereihte Track nie dran
    // -> automatisch auf "alle" umstellen.
    let loopSwitched = false;
    const cur = await readLoop(page);
    if (cur.mode === "one") {
      loopSwitched = await setLoopMode(page, "all");
    }

    console.log(
      `[browser] "${info.title || query}" als Naechstes eingereiht` +
        (loopSwitched ? " (Loop: ein Titel -> alle)." : ".")
    );
    return { ...info, loopSwitched };
  } catch (err) {
    console.warn(`[browser] Queue "${query}" fehlgeschlagen:`, err.message);
    return false;
  }
}

/**
 * Sucht eine Playlist und spielt sie ab:
 *   1. Playlist-Treffer (<a href*="/playlist/">) anklicken -> Playlist-Seite
 *   2. grossen "Abspielen"-Button klicken (Text stabil, class gehasht)
 */
async function playPlaylist(page, query) {
  if (!(await performSearch(page, query))) return false;

  // Playlist-Eintrag bevorzugt nach Titel, sonst ersten Playlist-Treffer.
  let entry = page
    .locator('#results-panel a[href*="/playlist/"]')
    .filter({ hasText: query })
    .first();
  if ((await entry.count()) === 0) {
    entry = page.locator('#results-panel a[href*="/playlist/"]').first();
  }
  try {
    await entry.waitFor({ state: "visible", timeout: 5000 });
  } catch {
    console.warn(`[browser] Playlist "${query}" nicht gefunden.`);
    return false;
  }
  const rawTitle = await entry.innerText().catch(() => query);
  const title = (rawTitle.split("\n")[0] || query).trim();
  await entry.click();

  // Auf der Playlist-/Album-Seite den grossen "Abspielen"-Button klicken.
  const playBtn = page.getByRole("button", { name: /^abspielen$/i }).first();
  try {
    await playBtn.waitFor({ state: "visible", timeout: 6000 });
    await playBtn.click();
  } catch {
    console.warn('[browser] "Abspielen"-Button auf der Playlist nicht gefunden.');
    return false;
  }

  console.log(`[browser] Playlist gestartet: "${title}".`);
  return title;
}

/**
 * Diagnose-Helfer: listet Beschriftung/aria-label der ersten sichtbaren
 * Buttons, damit wir den richtigen Play-Selektor finden koennen.
 */
async function dumpButtons(page) {
  try {
    const infos = await page.$$eval("button", (btns) =>
      btns.slice(0, 40).map((b) => ({
        text: (b.innerText || "").trim().slice(0, 30),
        aria: b.getAttribute("aria-label"),
        testid: b.getAttribute("data-testid"),
      }))
    );
    for (const i of infos) {
      if (i.text || i.aria || i.testid) {
        console.log(
          `   - text="${i.text}" aria="${i.aria ?? ""}" testid="${i.testid ?? ""}"`
        );
      }
    }
  } catch (err) {
    console.error("[browser] Button-Dump fehlgeschlagen:", err.message);
  }
}

/**
 * Legt die Audio-Ausgabe aller chrome.exe-Streams auf "CABLE Input".
 * Best effort: ohne SoundVolumeView.exe wird uebersprungen.
 */
function routeChromeAudioToCable(cfg, quiet = false) {
  if (!fs.existsSync(cfg.soundVolumeViewPath)) {
    if (!quiet) {
      console.warn(
        "[browser] SoundVolumeView.exe nicht gefunden – Audio wird NICHT auf\n" +
          "          das Kabel geroutet. Lege die .exe neben browser.js oder\n" +
          "          setze soundVolumeViewPath. (Download: nirsoft.net)"
      );
    }
    return;
  }

  // /SetAppDefault <Geraet> <Rolle:all|console|...> <Prozess>
  const svv = spawn(cfg.soundVolumeViewPath, [
    "/SetAppDefault",
    cfg.cableInputName,
    "all",
    "chrome.exe",
  ]);
  svv.on("error", (err) =>
    console.error("[browser] SoundVolumeView-Fehler:", err.message)
  );
  if (!quiet) {
    svv.on("exit", () =>
      console.log(`[browser] Chrome-Audio -> "${cfg.cableInputName}" gesetzt.`)
    );
  }
}

module.exports = { startNintendoMusic };
