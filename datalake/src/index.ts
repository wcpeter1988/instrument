import express from 'express';
import path from 'path';
import fs from 'fs';
import { createDataRouter } from './routes/data';
import { createConfigRouter } from './routes/config';
import { createGenRouter } from './routes/gen';

// Entry point: mounts data + config routers and serves UI.

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3300;
const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
ensureDir(DATA_DIR);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Mount API routers
app.use('/api', createDataRouter(DATA_DIR));
app.use('/api', createConfigRouter(DATA_DIR));
app.use('/api', createGenRouter(DATA_DIR));

// Static UI
const uiDir = path.join(__dirname, 'public');
ensureDir(uiDir);
app.use('/', express.static(uiDir));

app.listen(PORT, () => {
  console.log(`datalake service listening on http://localhost:${PORT}`);
});
