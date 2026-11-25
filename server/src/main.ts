import { loadConfig } from "./config.ts";
import { openDatabase, ping } from "./db/client.ts";
import { migrateDatabase } from "./db/migrate.ts";
import { buildApp } from "./http/app.ts";
import { changesFeed } from "./services/changes.ts";
import { alertmanagerAlertsFrom } from "./services/home.ts";
import { servicesFor } from "./services/index.ts";
import { irmHeartbeatsFrom } from "./services/irm-heartbeats.ts";
import { metricsFrom } from "./services/metrics.ts";
import { reconcilerFor } from "./services/reconcile.ts";
import { silencesFrom } from "./services/silences.ts";
import { alertmanagerSource } from "./sources/alertmanager/index.ts";

const config = loadConfig();
const { pool, db } = openDatabase(config.databaseUrl);
const silences = silencesFrom(config.alertmanagers, {
  // Reads go on without that instance's silences; the client sees no silence.
  onReadError: (instance, error) =>
    app.log.warn({ instance, err: error }, "could not read silences from Alertmanager"),
});
const alerts = alertmanagerAlertsFrom(config.alertmanagers, {
  // The home view shows the instance as unreachable, with its last alerts if any.
  onReadError: (instance, error) =>
    app.log.warn({ instance, err: error }, "could not read alerts from Alertmanager"),
});
const heartbeats = irmHeartbeatsFrom(
  config.irm,
  new Map(
    [...config.alertmanagers].flatMap(([instance, { irmIntegrationId }]) =>
      irmIntegrationId === null ? [] : [[instance, irmIntegrationId] as const],
    ),
  ),
  {
    // The home view shows the heartbeat as unknown, or its last status, with the error.
    onReadError: (integrationId, error) =>
      app.log.warn({ integrationId, err: error }, "could not read heartbeats from Grafana IRM"),
  },
);
const metrics = metricsFrom(config.metrics, {
  // The client shows the graph's error; the message names no host or credential.
  onReadError: (instance, error) =>
    app.log.warn({ instance, err: error }, "could not read metrics"),
});
const changes = changesFeed();
const services = servicesFor(db, { silences, alerts, heartbeats, changes, metrics });
const app = buildApp({
  logLevel: config.logLevel,
  sources: [alertmanagerSource],
  services,
  checkReady: () => ping(pool),
  handlers: { tokens: config.handlerTokens },
});

/**
 * Runs `task` every `everyMs`, one run at a time: a slow one delays the next rather than
 * overlapping it. A failure is logged and the next run goes ahead.
 */
function repeat(everyMs: number, task: () => Promise<void>, failure: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const schedule = (delayMs: number) => {
    if (!stopped) {
      timer = setTimeout(() => {
        running = run();
      }, delayMs);
    }
  };
  const run = async () => {
    try {
      await task();
    } catch (error) {
      app.log.error({ err: error }, failure);
    }
    schedule(everyMs);
  };
  return {
    /** The first run comes after `delayMs`. */
    start: schedule,
    /** Waits for a run in progress, so the pool doesn't close under it. */
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}

// Resolves what is gone from its Alertmanager (ADR 0014).
const reconciler = reconcilerFor(db, alerts, changes);
const reconcileEveryMs = 60_000;
const reconciling = repeat(
  reconcileEveryMs,
  async () => {
    const { resolved } = await reconciler.run();
    if (resolved.length > 0) {
      app.log.info({ occurrences: resolved }, "resolved occurrences gone from Alertmanager");
    }
  },
  "could not resolve occurrences gone from Alertmanager",
);

// Resurfaces the occurrences whose reminder came due (ADR 0025), within half a minute.
// The query is an index range scan, cheap when nothing is due.
const remindEveryMs = 30_000;
const reminding = repeat(
  remindEveryMs,
  async () => {
    const reminded = await services.remindDue();
    if (reminded.length > 0) {
      app.log.info({ occurrences: reminded }, "reminded of occurrences");
    }
  },
  "could not remind of occurrences",
);

// Records the handovers the clock ended and forgets handlers long gone (ADR 0022).
const sweepEveryMs = 60_000;
const sweeping = repeat(
  sweepEveryMs,
  () => services.handovers.sweep(),
  "could not sweep handovers",
);

// An idle connection that breaks must not crash the process; the pool reconnects.
pool.on("error", (error) => app.log.error({ err: error }, "database connection failed"));

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await Promise.all([reconciling.stop(), reminding.stop(), sweeping.stop()]);
  await app.close();
  await pool.end();
}

process.once("SIGTERM", (signal) => void shutdown(signal));
process.once("SIGINT", (signal) => void shutdown(signal));

await migrateDatabase(pool);
app.log.info("database migrated");
await app.listen({ host: config.host, port: config.port });
reconciling.start(reconcileEveryMs);
// At once: what came due while the server was down resurfaces now.
reminding.start(0);
sweeping.start(sweepEveryMs);
