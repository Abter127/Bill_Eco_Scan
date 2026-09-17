import { openDb } from '../db/sqlite.js';
import { buildServer } from './server.js';
import { runNightly } from '../services/jobs.js';

const db = openDb();
const app = await buildServer({ db, logger: true });

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

await app.listen({ port, host });
app.log.info(`Billing Hub listening on http://${host}:${port}`);

// The hold-window sweep and the warranty reminders. In a real deployment these
// run as a separate scheduled worker, not in the request process; the interval
// here keeps a single-process deployment honest.
const nightly = setInterval(() => {
  try {
    const result = runNightly(db, new Date());
    app.log.info({ result }, 'nightly sweep');
  } catch (err) {
    app.log.error(err, 'nightly sweep failed');
  }
}, 6 * 3600 * 1000);
nightly.unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, closing`);
    clearInterval(nightly);
    void app.close().then(() => { db.close(); process.exit(0); });
  });
}
