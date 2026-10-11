'use strict';
// Punto de entrada. Toda la lógica vive en src/ (ver docs/ARQUITECTURA.md).
//
// CLUSTER_WORKERS=N (N>1) arranca N procesos de trabajo que comparten el puerto y usan Redis para coordinarse (igual que varias instancias).
// Sirve para aprovechar varios núcleos de UNA instancia. Sin REDIS_URL se usa un solo proceso (el estado en memoria no se puede compartir).
const cluster = require('cluster');

// Validación temprana y ruidosa de la configuración: un error de arranque (p. ej. falta MASTER_PASSWORD) debe verse en UNA línea clara de los logs
// de Render y terminar el proceso con código 1, no como una traza de pila ni como un bucle de reinicios de procesos de trabajo.
if (cluster.isPrimary) {
  try {
    const cfg = require('./src/config').loadConfig(process.env);
    if (cfg.production && !cfg.redisUrl) console.warn(JSON.stringify({ level: 'warn', msg: 'single_instance_memory_state', detail: 'Sin REDIS_URL el estado vive en memoria: usar UNA sola instancia y un solo proceso (no escalar horizontalmente).' }));
  } catch (e) {
    console.error(JSON.stringify({ level: 'fatal', msg: 'startup_config_invalid', error: e.message }));
    process.exit(1);
  }
}

const wanted = Math.max(1, Math.floor(Number(process.env.CLUSTER_WORKERS || 1)));
const workers = wanted > 1 && !process.env.REDIS_URL ? 1 : wanted;
if (wanted > 1 && workers === 1 && cluster.isPrimary) console.warn('CLUSTER_WORKERS ignorado: requiere REDIS_URL (el estado en memoria no se comparte entre procesos).');

if (workers > 1 && cluster.isPrimary) {
  if (!process.env.MASTER_PASSWORD) {
    // desarrollo: una sola contraseña temporal compartida por todos los procesos de trabajo (si no, cada uno generaría la suya)
    process.env.MASTER_PASSWORD = require('crypto').randomBytes(9).toString('base64url');
    console.log(`\n[DEV] MASTER_PASSWORD no definida: contraseña temporal del panel /master = ${process.env.MASTER_PASSWORD}\n`);
  }
  cluster.schedulingPolicy = cluster.SCHED_RR;       // reparto equitativo de conexiones (en Windows el predeterminado es SCHED_NONE)
  let stopping = false;
  const spawnWorker = () => cluster.fork();
  for (let i = 0; i < workers; i++) spawnWorker();
  cluster.on('exit', (w, code) => {
    if (stopping) return;
    console.error(JSON.stringify({ level: 'error', msg: 'worker_exit', worker: w.id, code }));
    setTimeout(spawnWorker, 500);
  });
  const stop = sig => {
    if (stopping) return; stopping = true;
    for (const w of Object.values(cluster.workers)) { try { w.send({ cmd: 'shutdown', sig }); } catch { /* ya terminó */ } }
    const grace = Number(process.env.SHUTDOWN_GRACE_MS || 20000) + 5000;
    const t = setInterval(() => { if (!Object.keys(cluster.workers).length) { clearInterval(t); process.exit(0); } }, 100);
    setTimeout(() => process.exit(0), grace).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
} else {
  if (cluster.isWorker) process.env.INSTANCE_ID = `${process.env.INSTANCE_ID || require('os').hostname()}-w${cluster.worker.id}`;
  const { createApp } = require('./src/app');
  let app;
  try { app = createApp(); } catch (e) { console.error(JSON.stringify({ level: 'fatal', msg: 'startup_failed', error: e.message })); process.exit(1); }

  app.start().then(() => {
    if (app.config.masterPasswordGenerated && !cluster.isWorker) {
      // Solo en desarrollo (sin NODE_ENV=production): se imprime UNA vez porque no hay otra forma de conocerla.
      console.log(`\n[DEV] MASTER_PASSWORD no definida: contraseña temporal del panel /master = ${app.config.masterPassword}\n`);
    }
  }).catch(err => {
    console.error('No se pudo iniciar:', err.message);
    process.exit(1);
  });

  let closing = false;
  async function onSignal(sig) {
    if (closing) return;
    closing = true;
    try { await app.shutdown(sig); } finally { process.exit(0); }
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('message', m => { if (m && m.cmd === 'shutdown') onSignal(m.sig || 'SIGTERM'); });
  process.on('unhandledRejection', err => app.logger.error('unhandledRejection', { error: String(err && err.message || err) }));
  process.on('uncaughtException', err => {
    app.logger.error('uncaughtException', { error: err.message });
    process.exit(1);     // estado desconocido: se deja que la plataforma (o el proceso primario) reinicie el proceso
  });
}
