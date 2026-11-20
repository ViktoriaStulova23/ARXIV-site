import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildServer } from './app.js';

const staticRoot = resolve(import.meta.dirname, '../client');
const app = await buildServer({ logger: true, staticRoot: existsSync(resolve(staticRoot, 'index.html')) ? staticRoot : undefined });
try {
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
