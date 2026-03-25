const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs   = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
const TMP  = path.join(__dirname, 'tmp');

if (!fs.existsSync(TMP)) fs.mkdirSync(TMP);

// Helmet sin CSP para evitar bloqueos de JS inline
app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors({
  origin: ['https://ytsnap.up.railway.app', 'https://yt-converter-production-2ca3.up.railway.app']
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiadas peticiones. Espera 15 minutos.' }
});
app.use('/convert', limiter);

// Limpieza cada 5 minutos
setInterval(() => {
  fs.readdir(TMP, (_, files) => {
    files?.forEach(f => {
      const fp = path.join(TMP, f);
      fs.stat(fp, (_, s) => {
        if (s && Date.now() - s.mtimeMs > 5 * 60 * 1000) fs.unlink(fp, () => {});
      });
    });
  });
}, 5 * 60 * 1000);

function isValidYoutubeUrl(url) {
  try {
    const u = new URL(url);
    const validHosts = ['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com'];
    if (!validHosts.includes(u.hostname)) return false;
    if (u.hostname === 'youtu.be' && u.pathname.length < 2) return false;
    if (u.hostname.includes('youtube.com') && !u.searchParams.get('v')) return false;
    return true;
  } catch { return false; }
}

function cleanYoutubeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname === 'youtu.be') return `https://www.youtube.com/watch?v=${u.pathname.slice(1)}`;
    const videoId = u.searchParams.get('v');
    if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
    return rawUrl;
  } catch { return rawUrl; }
}

const AUDIO_FORMATS = ['mp3', 'wav', 'flac', 'aac', 'ogg'];
const VIDEO_FORMATS = ['mp4'];
const ALL_FORMATS   = [...AUDIO_FORMATS, ...VIDEO_FORMATS];

// ── Parámetros ffmpeg optimizados por formato para software DJ ─────────────
// Todos a 44100Hz estéreo — frecuencia estándar de Traktor, Serato, Rekordbox
const DJ_FFMPEG_ARGS = {
  mp3:  ['-ar', '44100', '-ac', '2', '-b:a', '320k', '-write_xing', '0'],
  // CBR 320kbps — Traktor analiza mucho mejor CBR que VBR
  // write_xing 0 = sin cabecera Xing, evita errores de duración en Traktor

  wav:  ['-ar', '44100', '-ac', '2', '-acodec', 'pcm_s16le'],
  // PCM 16-bit — formato nativo sin pérdida, análisis instantáneo en Traktor

  flac: ['-ar', '44100', '-ac', '2', '-compression_level', '5'],
  // FLAC nivel 5 — balance entre tamaño y velocidad de carga

  aac:  ['-ar', '44100', '-ac', '2', '-b:a', '256k'],
  // AAC 256kbps — buena calidad para uso general

  ogg:  ['-ar', '44100', '-ac', '2', '-q:a', '10'],
  // OGG calidad máxima (q10 ≈ 500kbps)
};

app.post('/convert', (req, res) => {
  const { url, format } = req.body;

  if (!url || !isValidYoutubeUrl(url)) {
    return res.status(400).json({ error: 'URL de YouTube inválida' });
  }
  if (!ALL_FORMATS.includes(format)) {
    return res.status(400).json({ error: 'Formato no soportado' });
  }

  const cleanUrl = cleanYoutubeUrl(url);
  const id       = uuidv4();
  const outFile  = path.join(TMP, `${id}.${format}`);

  let args;

  if (format === 'mp4') {
    args = [
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--extractor-args', 'youtube:player_client=web_safari,ios',
      '--match-filter', 'duration < 1200',
      '--no-playlist',
      '--embed-thumbnail',
      '--add-metadata',
      '-o', outFile,
      cleanUrl
    ];
  } else {
    // Parámetros ffmpeg DJ pasados directamente al postprocesador
    const ffmpegArgs = DJ_FFMPEG_ARGS[format].join(' ');

    args = [
      '-x',
      '--audio-format', format,
      '--audio-quality', '0',           // descarga la mejor calidad de origen
      '--postprocessor-args', `ffmpeg:${ffmpegArgs}`,  // conversión DJ-ready
      '--extractor-args', 'youtube:player_client=web_safari,ios',
      '--match-filter', 'duration < 1200',
      '--no-playlist',
      '--embed-thumbnail',               // portada del video como carátula
      '--add-metadata',                  // título, artista desde YouTube
      '--parse-metadata', 'title:%(title)s',
      '-o', outFile,
      cleanUrl
    ];
  }

  execFile('yt-dlp', args, { timeout: 180_000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[yt-dlp error]', stderr);
      const lines = (stderr || '').split('\n');
      const errorLine = lines.find(l => l.includes('ERROR:')) || lines[0] || 'Error desconocido';
      return res.status(500).json({ error: errorLine.substring(0, 200) });
    }
    res.json({ id, format });
  });
});

app.get('/download/:id/:format', (req, res) => {
  const { id, format } = req.params;

  if (!/^[0-9a-f-]{36}$/.test(id) || !ALL_FORMATS.includes(format)) {
    return res.status(400).send('Parámetros inválidos');
  }

  const file = path.join(TMP, `${id}.${format}`);
  if (!fs.existsSync(file)) return res.status(404).send('Archivo no encontrado o expirado');

  res.download(file, `descarga.${format}`, () => fs.unlink(file, () => {}));
});

app.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
