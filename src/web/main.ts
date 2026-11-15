#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { loadConfiguration } from '../adapters/config.js';
import { createWebRuntime } from './runtime.js';
import { startWebServer } from './server.js';

async function main() {
  const checked = await loadConfiguration({ cwd: process.cwd(), home: homedir(), xdgConfigHome: process.env.XDG_CONFIG_HOME, environment: process.env,
    base: { relays: ['wss://nos.lol'], maxSeedZaps: 20, maxCoZappers: 20, maxZapsPerCoZapper: 20, cachePath: resolve(process.env.DATA_DIR ?? 'data', 'wot.sqlite') } });
  if (!checked.ok) throw new Error(checked.error.message);
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const runtime = await createWebRuntime({ config: checked.value, apiKey: process.env.OPENAI_API_KEY, telemetryEnvironment: process.env });
  if (!runtime.ok) { process.stderr.write(`${runtime.error.message}\n`); process.exitCode = 1; return; }
  const app = await startWebServer({ runtime: runtime.value, profileRelays: checked.value.relays, host: process.env.HOST ?? '127.0.0.1', port });
  process.stdout.write(`SemanticWOT listening at ${app.url}\n`);
  let closing = false;
  const stop = () => { if (!closing) { closing = true; void app.close().catch(() => { process.exitCode = 1; }); } };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Cannot start SemanticWOT.'}\n`); process.exitCode = 1; });
