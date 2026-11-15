import type { createWebRuntime, WebRuntimeOptions } from '../../src/web/runtime.js';
// The executable process deliberately imports the built distribution, just as the container does.
const built = await import(new URL('../../dist/web/runtime.js', import.meta.url).href) as { createWebRuntime: typeof createWebRuntime };
const { startWebServer } = await import(new URL('../../dist/web/server.js', import.meta.url).href) as typeof import('../../src/web/server.js');
process.once('message', async (input: { config: WebRuntimeOptions['config']; apiKey?: string; now: number }) => {
  try {
    const runtime = await built.createWebRuntime({ config: input.config, apiKey: input.apiKey, clock: { now: () => input.now } });
    if (!runtime.ok) { process.stderr.write(`${runtime.error.message}\n`); process.exit(1); }
    const app = await startWebServer({ runtime: runtime.value, port: 0 });
    process.send?.({ url: app.url });
    process.once('SIGTERM', () => { void app.close().then(() => process.exit(0)); });
  } catch { process.exit(1); }
});
