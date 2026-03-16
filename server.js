const express   = require('express');
const cors      = require('cors');
const { execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs   = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const TMP  = path.join(__dirname, 'tmp');

if (!fs.existsSync(TMP)) fs.mkdirSync(TMP);

setInterval(() => {
  fs.readdir(TMP, (_, files) => {
    files?.forEach(f => {
      const fp = path.join(TMP, f);
      fs.stat(fp, (_, s) => {
        if (s && Date.now() - s.mtimeMs > 10 * 60 * 1000) fs.unlink(fp, () => {});
      });
    });
  });
}, 10 * 60 * 1000);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.post('/convert', (req, res) => {
  const { url, format } = req.body;
  if (!url || !/youtu\.?be/.test(url)) {
    return res.status(400).json({ error: 'URL de YouTube inválida' });
  }
  if (!['mp3', 'mp4', 'wav'].includes(format)) {
    return res.status(400).json({ error: 'Formato no soportado' });
  }

  const id      = uuidv4();
  const outFile = path.join(TMP, `${id}.${format}`);

  const args = format === 'mp4'
    ? ['-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
       '--merge-output-format', 'mp4', '--no-playlist', '-o', outFile, url]
    : ['-x', '--audio-format', format, '--audio-quality', '0',
       '--no-playlist', '-o', outFile, url];

  execFile('yt-dlp', args, { timeout: 180_000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[yt-dlp error]', stderr);
      return res.status(500).json({ error: 'No se pudo convertir. El video puede estar bloqueado o privado.' });
    }
    res.json({ id, format });
  });
});

app.get('/download/:id/:format', (req, res) => {
  const { id, format } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(id) || !['mp3','mp4','wav'].includes(format)) {
    return res.status(400).send('Parámetros inválidos');
  }
  const file = path.join(TMP, `${id}.${format}`);
  if (!fs.existsSync(file)) return res.status(404).send('Archivo no encontrado o expirado');
  res.download(file, `descarga.${format}`, () => fs.unlink(file, () => {}));
});

app.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
