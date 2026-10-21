import { app } from './app.js'; import { env } from './config/env.js'; import { closeDatabase } from './db/client.js';
const server = app.listen(env.PORT, () => console.info(JSON.stringify({ event: 'server_started', port: env.PORT }))); let shuttingDown = false;
async function shutdown(signal: string) { if (shuttingDown) return; shuttingDown = true; console.info(JSON.stringify({ event: 'shutdown_started', signal })); server.close(async () => { await closeDatabase(); console.info(JSON.stringify({ event: 'shutdown_complete' })); process.exit(0); }); setTimeout(() => process.exit(1), 10000).unref(); }
process.once('SIGINT', () => void shutdown('SIGINT')); process.once('SIGTERM', () => void shutdown('SIGTERM'));
