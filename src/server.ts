import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import Fastify from 'fastify';
import { registerRoutes } from './api/routes.ts';
import { loadConfig, type Config } from './config.ts';
import { closePool, ensureDatabaseExists, migrateToLatest } from './db.ts';
import { SnowModel } from './jobs/model.ts';
import { Worker } from './jobs/worker.ts';
import { ROOT } from './paths.ts';
import { ResortRegistry } from './resorts/registry.ts';
import { readIniTemplate } from './snowpack/config.ts';
import { snowpackVersion } from './snowpack/runner.ts';
import { OpenMeteoClient } from './weather/open-meteo.ts';

export async function buildServer(config: Config = loadConfig()) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  if (config.autoMigrate) {
    const created = await ensureDatabaseExists();
    if (created) app.log.info(`created database ${created}`);
    await migrateToLatest();
  }

  const iniTemplate = readIniTemplate();
  const registry = ResortRegistry.load(
    join(ROOT, 'config', 'resorts'),
    iniTemplate,
  );
  const openMeteo = new OpenMeteoClient({
    baseUrl: config.openMeteoUrl,
    dataDir: config.dataDir,
  });
  const version = await snowpackVersion(config.snowpackBin);
  if (!version)
    app.log.warn(`could not run ${config.snowpackBin}; model jobs will fail`);

  const model = new SnowModel({
    config,
    registry,
    openMeteo,
    iniTemplate,
    snowpackVersion: version ?? 'unknown',
  });
  const worker = new Worker(model, app.log, config.workerPollMs);

  await registerRoutes(app, {
    config,
    registry,
    openMeteo,
    snowpackVersion: version,
    onJobCreated: () => worker.nudge(),
  });

  app.addHook('onReady', async () => {
    if (config.workerEnabled) worker.start();
  });
  app.addHook('onClose', async () => {
    await worker.stop();
    await closePool();
  });
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig();
  const app = await buildServer(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info(`${signal} received, shutting down`);
      void app.close().then(() => process.exit(0));
    });
  }
  await app.listen({ port: config.port, host: config.host });
}
