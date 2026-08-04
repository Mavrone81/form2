import express from 'express';
import session from 'express-session';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { seedDemoUsers } from './seed.js';
import { makeRoutes } from './routes.js';

export function createApp({ db }) {
  const app = express();
  app.use(express.json({ limit: '4mb' })); // signature PNGs
  app.use(session({
    secret: process.env.SESSION_SECRET ?? randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' }
  }));
  app.use('/api', makeRoutes(db));
  app.use(express.static(fileURLToPath(new URL('../web', import.meta.url))));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  seedDemoUsers(db);
  const port = Number(process.env.PORT ?? 3000);
  createApp({ db }).listen(port, () => console.log(`PM forms running at http://localhost:${port}`));
}
