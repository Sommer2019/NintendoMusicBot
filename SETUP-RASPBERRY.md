# DCNintendoMusic auf dem Raspberry Pi (Pi 4, 64-bit)

Der Code ist cross-platform. Auf Linux ersetzt **PulseAudio** das VB-Cable und
**Xvfb** das versteckte Fenster. Der einzige echte Risikopunkt ist **Widevine**
(DRM) auf ARM — deshalb steht der Widevine-Test ganz vorne.

> Voraussetzung: **64-bit Raspberry Pi OS** (Bookworm) auf einem Pi 4 (≥2 GB).

---

## 0. ⚠️ ZUERST: Widevine testen (Go/No-Go)

Ohne funktionierendes Widevine spielt Nintendo Music nicht — dann ist der ganze
Pi-Plan hinfällig. Also zuerst prüfen:

```bash
sudo apt update
sudo apt install -y chromium-browser
chromium-browser --version
```

Öffne am **Pi-Desktop** (Monitor/HDMI oder VNC) in Chromium eine DRM-Testseite
(z. B. https://bitmovin.com/demos/drm oder direkt music.nintendo.com nach Login).
- **Spielt geschütztes Audio/Video** → Widevine ist da. Weiter mit Schritt 1. ✅
- **DRM-Fehler / nichts spielt** → Widevine fehlt auf deinem Image. Dann stoppen
  und mir Bescheid geben — ohne Widevine bringt der Rest nichts. ❌

Pfad zum Chromium merken (nur falls die Auto-Erkennung nicht greift):
```bash
which chromium-browser || which chromium
```

---

## 1. Pakete installieren

```bash
sudo apt install -y ffmpeg xvfb pulseaudio-utils git
# Node 20 (apt-Version ist oft zu alt für discord.js v14):
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # sollte v20.x zeigen
```

## 2. Projekt holen & Abhängigkeiten

```bash
git clone <dein-repo> dcnintendomusic   # oder per scp kopieren
cd dcnintendomusic
npm install
npm i playwright          # KEIN "npx playwright install chrome" (gibt es nicht für ARM)
```

Wir nutzen das **System-Chromium** (hat Widevine), nicht Playwrights Bundle.
`browser.executablePath` kann leer bleiben, wenn Chromium in einem der üblichen
Pfade liegt (`/usr/bin/chromium-browser`, `/usr/bin/chromium`, `/snap/bin/chromium`).

## 3. config.json anlegen

```bash
cp config.example.json config.json
nano config.json
```

Auf dem Pi wichtig:
```json
{
  "token": "DEIN_BOT_TOKEN",
  "guildId": "",
  "ffmpegPath": "ffmpeg",
  "browser": {
    "enabled": true,
    "visible": false,
    "executablePath": "/usr/bin/chromium-browser",
    "audioSink": "ntmusic"
  }
}
```
- `ffmpegPath: "ffmpeg"` → System-FFmpeg (kann PulseAudio; `ffmpeg-static` oft nicht).
- `executablePath` → optional; nur setzen, wenn Chromium an einem anderen Pfad
  liegt als die üblichen Standardpfade.
- `audioDevice` wird auf Linux **nicht** gebraucht.

## 4. Einmalig bei Nintendo einloggen (mit Bild)

Der Login braucht einmal einen sichtbaren Browser. Am **Pi-Desktop** (HDMI oder
VNC), im Projektordner:

```bash
npm run browser:login
```
→ Bei Nintendo Music einloggen, kurz abspielen (DRM prüfen!). Das Profil wird in
`chrome-profile/` gespeichert. Fenster mit STRG+C schließen.

> Hinweis: Falls kein X-Server läuft, startet der Code automatisch eine
> temporäre Xvfb-Session. Das verhindert den Startfehler, ist aber kein echter
> sichtbarer Desktop. Für einen wirklich sichtbaren Login brauchst du weiterhin
> HDMI/VNC oder ein anderes `DISPLAY`.

## 5. Headless-Betrieb testen

Der Bot startet Chromium „headed" in einen **virtuellen Bildschirm** (Xvfb):

```bash
xvfb-run -a npm start
```
- Der null-sink `ntmusic` wird automatisch angelegt (Log: `[audio] … null-sink … angelegt`).
- In Discord: `/join` → `/track ...` → Ton sollte im Voice-Channel ankommen.

Wenn kein Ton kommt, prüfe:
```bash
pactl list short sinks            # ntmusic vorhanden?
pactl list short sink-inputs      # läuft chromium auf ntmusic?
```

## 6. Als Dienst dauerhaft laufen lassen (systemd)

`/etc/systemd/system/dcnintendomusic.service`:
```ini
[Unit]
Description=DCNintendoMusic Bot
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/dcnintendomusic
# Xvfb-Wrapper, damit der headed Chromium einen Bildschirm hat:
ExecStart=/usr/bin/xvfb-run -a /usr/bin/node index.js
Restart=on-failure
RestartSec=5
# PulseAudio des Nutzers erreichen:
Environment=XDG_RUNTIME_DIR=/run/user/1000

[Install]
WantedBy=multi-user.target
```
(`User`/Pfade/UID anpassen — `id -u pi` zeigt die UID.)

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dcnintendomusic
journalctl -u dcnintendomusic -f      # Logs ansehen
```

---

## Troubleshooting

- **`9012-5401` / DRM-Fehler:** Widevine im System-Chromium fehlt/zu alt → Schritt 0.
- **Kein Ton, sink-input fehlt:** Läuft PulseAudio/PipeWire im Service-Kontext?
  `XDG_RUNTIME_DIR` korrekt? Ggf. Bot als der Desktop-User starten.
- **Chromium spielt, aber Discord bleibt stumm:** Prüfe, ob der Sink wirklich auf
  `ntmusic` zeigt:
  ```bash
  pactl set-default-sink ntmusic
  pactl list short sink-inputs
  ```
  Im Bot-Log sollte außerdem etwas wie `Linux-Audio -> Sink "ntmusic" gesetzt`
  auftauchen.
- **FFmpeg „Unknown input format pulse":** `ffmpegPath` zeigt auf `ffmpeg-static`
  statt System-FFmpeg → in config.json `"ffmpegPath": "ffmpeg"`.
- **Chromium startet nicht headless:** immer über `xvfb-run` starten.
- **Hoher CPU-Verbrauch:** Pi 4 schafft einen Stream; mehrere parallel nicht.
