import express from 'express';
import session from 'express-session';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { seedDemoUsers } from './seed.js';
import { makeRoutes } from './routes.js';
import { resolveConfig } from './config.js';
import { scanFolder } from './scanner.js';

export function createApp({ db, sessionSecret }) {
  const app = express();
  app.use(express.json({ limit: '4mb' })); // signature PNGs
  app.use(session({
    secret: sessionSecret ?? resolveConfig({}).sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' }
  }));
  app.use('/api', makeRoutes(db));
  app.use(express.static(fileURLToPath(new URL('../web', import.meta.url))));

  // Last resort: anything that reaches here (a synchronous throw Express
  // caught itself, or an asyncRoute-wrapped rejection routed via next(err))
  // must never reach the client as a stack trace or filesystem path.
  // Express's own default handler does exactly that whenever NODE_ENV isn't
  // "production", so this one always wins by being registered after
  // everything else and always responding itself.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = resolveConfig();
  const db = openDb(config.dbPath);
  seedDemoUsers(db);

  // A container comes up already pointing at its mounted /forms — but only
  // the first time. Once an admin has set (or cleared) the folder through the
  // UI, that choice is the source of truth and boot must not override it.
  if (config.formsDir) {
    const current = db.prepare("select value from settings where key='forms_folder'").get()?.value ?? '';
    if (!current) {
      db.prepare(`insert into settings (key,value) values ('forms_folder',?)
        on conflict(key) do update set value=excluded.value`).run(config.formsDir);
      try {
        const result = await scanFolder(db, config.formsDir);
        console.log(`Initial scan of ${config.formsDir}: added ${result.added}, updated ${result.updated}, deactivated ${result.deactivated}, failed ${result.failed}`);
      } catch (err) {
        // The admin can fix the path from the UI once logged in — a broken
        // FORMS_DIR at boot must never prevent the server from starting.
        console.error(`Could not scan FORMS_DIR (${config.formsDir}) at boot — server is starting anyway:`, err);
      }
    }
  }

  createApp({ db, sessionSecret: config.sessionSecret })
    .listen(config.port, () => console.log(`PM forms running at http://localhost:${config.port}`));
}
