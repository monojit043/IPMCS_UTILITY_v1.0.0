// STEP 1 (first install only): checks the .env, creates the module's EMPTY database and builds its
// tables, then loads its starting data (if any). Stops without touching anything if the database
// already has tables — updates go through apply_update.bat instead.
const crypto = require('crypto');
const { ROOT, mod, envFile, readEnv, setEnvValue, isPlaceholder, dbConfig, appRequire, runScripts, main } = require('./lib');

main(async () => {
  let env = readEnv(ROOT);
  if (!env) throw new Error(`${envFile(ROOT)} not found — copy deploy\\production\\env.production.template there and fill it.`);
  for (const key of mod.generate || []) {
    if (isPlaceholder(env[key])) {
      setEnvValue(ROOT, key, crypto.randomBytes(32).toString('hex'));
      console.log(`${key} was empty — a new random value was written to .env`);
    }
  }
  env = readEnv(ROOT);
  const missing = mod.required.filter((k) => isPlaceholder(env[k]));
  if (missing.length) throw new Error(`Fill these in ${envFile(ROOT)} first: ${missing.join(', ')}`);
  if (env.SSO_SECRET.length < 32) throw new Error('SSO_SECRET must be the same (32+ characters) as in E:\\ePULSE_v1.0.0\\backend\\.env');

  const { Client } = appRequire(ROOT, 'pg');
  const cfg = dbConfig(env);
  const admin = new Client({ ...cfg, database: 'postgres' });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [cfg.database]);
    if (rowCount) {
      const db = new Client(cfg);
      await db.connect();
      const { rows: [{ n }] } = await db.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`);
      await db.end();
      if (n) throw new Error(`Database "${cfg.database}" already has ${n} tables — stopped, nothing was changed. For a new version use apply_update.bat.`);
      console.log(`Database "${cfg.database}" exists and is empty — using it.`);
    } else {
      await admin.query(`CREATE DATABASE "${cfg.database.replace(/"/g, '""')}"`);
      console.log(`Database "${cfg.database}" created.`);
    }
  } finally {
    await admin.end();
  }

  runScripts(ROOT, mod.migrate, 'tables');
  runScripts(ROOT, mod.seed, 'starting data');
  console.log(`\nSTEP 1 done. Next: step2_start_${mod.name.toLowerCase()}.bat`);
});
