// Listet alle DirectShow-Audiogeraete auf, damit du den exakten Namen
// deines virtuellen Kabels (z. B. "CABLE Output (VB-Audio Virtual Cable)")
// in die config.json eintragen kannst.
//
// Nutzung:  npm run devices

const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");

console.log("Frage FFmpeg nach den verfuegbaren DirectShow-Geraeten ...\n");

// FFmpeg gibt die Geraeteliste auf stderr aus. "-i dummy" provoziert die
// Ausgabe; der anschliessende Fehler ist erwartet und wird ignoriert.
const ff = spawn(ffmpegPath, [
  "-hide_banner",
  "-list_devices", "true",
  "-f", "dshow",
  "-i", "dummy",
]);

let out = "";
ff.stderr.on("data", (d) => (out += d.toString()));

ff.on("close", () => {
  // FFmpeg 5+/6 markiert jede Geraetezeile mit "(audio)" bzw. "(video)".
  // Beispiel:  [dshow @ ...] "Microphone (Realtek(R) Audio)" (audio)
  //            [dshow @ ...]   Alternative name "@device_cm_..."
  const lines = out.split(/\r?\n/);
  const audioDevices = [];
  let lastWasAudio = false;

  for (const line of lines) {
    const dev = line.match(/]\s+"([^"]+)"\s+\(audio\)/i);
    if (dev) {
      audioDevices.push({ name: dev[1], alt: null });
      lastWasAudio = true;
      continue;
    }
    const alt = line.match(/Alternative name\s+"([^"]+)"/i);
    if (alt && lastWasAudio && audioDevices.length) {
      audioDevices[audioDevices.length - 1].alt = alt[1];
    }
    if (/\((video|none)\)/i.test(line)) lastWasAudio = false;
  }

  if (audioDevices.length === 0) {
    console.log("Keine DirectShow-Audiogeraete gefunden.");
    console.log(
      "Hast du VB-Audio Cable schon installiert? Danach taucht hier\n" +
        '"CABLE Output (VB-Audio Virtual Cable)" auf.'
    );
    return;
  }

  for (const d of audioDevices) {
    console.log('  Audio-Geraet:  "' + d.name + '"');
    if (d.alt) console.log("       (alt.):  " + d.alt);
  }
  console.log(
    '\nTrage den passenden Namen 1:1 als "audioDevice" in deine config.json ein.\n' +
      'Fuer Nintendo-Music brauchst du "CABLE Output (VB-Audio Virtual Cable)".'
  );
});
