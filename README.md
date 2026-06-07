# DCNintendoMusic

Ein kleiner, **lokal laufender** Discord-Bot, der das **Browser-Audio** (z. B. von
[music.nintendo.com](https://music.nintendo.com/de-DE/)) live in einen
**Server-Voice-Channel** streamt.

Du loggst dich ganz normal per GUI im Browser bei Nintendo Music ein und spielst
ab — der Bot überträgt nur den Ton. Er kümmert sich nicht um Login/DRM.

## Wichtige Grenzen (bitte zuerst lesen)

- **Nur Server-Voice-Channels.** Discord-Bots können technisch **nicht** in
  persönliche DM-/Gruppen-Sprachanrufe. Erstelle dir einen kleinen privaten
  Server für dich und deine Freunde – das löst es in der Praxis.
- **Nur Browser-Audio:** Wir routen die Audio-Ausgabe deines Browsers über ein
  virtuelles Audiokabel und nehmen ausschließlich von diesem Kabel auf. So landet
  kein Discord-/Spiel-/System-Sound im Stream.
- Das Weiterleiten von Nintendos Musik ist urheberrechtlich Graubereich – für
  kleine private Runden meist unkritisch, aber sei dir dessen bewusst.

---

## 1. Virtuelles Audiokabel installieren (VB-Audio Cable)

1. Lade **VB-Audio Virtual Cable** herunter: <https://vb-audio.com/Cable/>
2. ZIP entpacken, `VBCABLE_Setup_x64.exe` **als Administrator** ausführen,
   installieren, danach **Windows neu starten**.

Danach gibt es zwei neue Geräte:
- `CABLE Input` (ein Wiedergabe-/Ausgabegerät) → da schicken wir den Browser-Ton rein.
- `CABLE Output` (ein Aufnahme-/Eingabegerät) → da nimmt der Bot auf.

## 2. Browser-Ton auf das Kabel routen (nur der Browser!)

So hört **nur** der Browser über das Kabel, alles andere bleibt normal:

1. Spiele kurz etwas im Browser ab (damit Windows ihn im Mixer anzeigt).
2. Windows-Einstellungen → **System → Sound → Lautstärkemixer**
   (bzw. „Erweiterte Lautstärkeoptionen / App-Lautstärke- und Geräteeinstellungen").
3. Such deinen Browser (Chrome/Firefox/Edge …) in der App-Liste.
4. Stelle dessen **Ausgabegerät** auf **`CABLE Input (VB-Audio Virtual Cable)`**.

> Tipp: Du hörst dann den Browser-Ton selbst nicht mehr direkt. Willst du
> trotzdem mithören, kannst du in den VB-Cable-Eigenschaften unter „Abhören"
> das Kabel auf deine Kopfhörer spiegeln – oder du hörst einfach über Discord mit.

## 3. Discord-Bot anlegen

1. <https://discord.com/developers/applications> → **New Application**.
2. Links **Bot** → **Add Bot** → **Reset Token** → Token kopieren.
3. **Privileged Gateway Intents** musst du **nicht** aktivieren (der Bot nutzt
   nur Slash-Commands).
4. Bot auf deinen Server einladen:
   Links **OAuth2 → URL Generator** → Scopes: **`bot`** und
   **`applications.commands`** → Bot Permissions: **Connect** und **Speak** →
   die erzeugte URL öffnen und den Bot deinem Server hinzufügen.

## 4. Konfiguration

In `config.json` eintragen:

- `token`   – der Bot-Token aus Schritt 3.
- `guildId` – (optional) deine Server-ID. Dann sind die Slash-Commands sofort
  da. Server-ID bekommst du per Rechtsklick auf den Server (Entwicklermodus in
  Discord aktivieren). Lässt du es weg, werden globale Commands registriert
  (können bis zu ~1 h zum Erscheinen brauchen).
- `audioDevice` – der exakte Name des Aufnahmegeräts. Standard passt für VB-Cable:
  `CABLE Output (VB-Audio Virtual Cable)`. Zum Prüfen siehe unten.

## 5. Installieren & starten

```powershell
npm install
npm run devices   # listet die Audio-Geräte – Namen ggf. in config.json korrigieren
npm start
```

`npm start` startet jetzt den Discord-Bot **und** den Browser-Runner. Ein schneller Test ist `/ping` oder `/status` im Discord-Server.

## 6. Benutzen

1. Geh auf deinem Server in einen **Voice-Channel**.
2. Tippe **`/join`** → der Bot kommt rein und streamt den Kabel-Ton.
3. Mit **`/stay`** bleibt der Bot dauerhaft im Channel. Wenn niemand mehr im Voice-Channel ist, pausiert die Wiedergabe automatisch; sobald wieder jemand reinkommt, startet sie wieder.
4. Mit **`/unstay`** beendest du den 24/7-Modus und trennst den Bot direkt.
5. Im **Browser** Nintendo Music abspielen → es läuft im Voice-Channel.
6. **`/leave`** stoppt und trennt den Bot. **`/status`** zeigt den Zustand.

> Hinweis: Der Discord-Bot antwortet jetzt sofort auf Slash-Commands. Falls du auf dem Pi keinen echten Desktop-Server hast, wird für den Browser automatisch Xvfb genutzt.

---

## Troubleshooting

- **Kein Ton im Channel:** Läuft im Browser wirklich was? Ist das Browser-Audio
  in den Windows-Sound-Einstellungen auf `CABLE Input` gestellt? Stimmt der
  `audioDevice`-Name (siehe `npm run devices`)?
- **`/join` zeigt „Geh erst in einen Voice-Channel":** Du musst selbst in einem
  Voice-Channel sein, bevor du den Befehl ausführst.
- **Slash-Commands erscheinen nicht:** Setze `guildId` für sofortige Befehle,
  oder warte bei globalen Commands etwas. Bot muss mit Scope
  `applications.commands` eingeladen sein.
- **Knackser/Aussetzer:** Andere CPU-lastige Programme schließen; ggf. hilft ein
  besseres WLAN/LAN.
