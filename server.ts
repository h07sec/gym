import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT) || 3000;
const distCandidates = [
  path.resolve(__dirname, 'dist'),
  path.resolve(__dirname, '..', 'dist'),
  path.resolve(process.cwd(), 'dist'),
];
const distDir =
  distCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ||
  path.resolve(process.cwd(), 'dist');
const indexFile = path.join(distDir, 'index.html');

app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use(
  '/assets',
  express.static(path.join(distDir, 'assets'), {
    maxAge: '1y',
    immutable: true,
  })
);

app.use(
  express.static(distDir, {
    index: false,
    maxAge: '1h',
  })
);

app.get('*', (_req, res) => {
  if (!fs.existsSync(indexFile)) {
    res.status(503).send('Application bundle not built. Run npm run build first.');
    return;
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(indexFile);
});

app.listen(port, '0.0.0.0', () => {
  console.log(`GymOS server listening on port ${port}`);
});
