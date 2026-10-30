// Puts the module back to how it was before an update:
//   rollback.bat [backup folder]      (default: the last update's, deploy\production\LAST_BACKUP.txt)
// Code always goes back. The database goes back only if you say YES — what was entered after the
// update is then lost. .env and uploads are never touched.
const fs = require('fs');
const path = require('path');
const { ROOT, mod, readEnv, dbConfig, appRequire, pgTool, run, assertStopped, readRelease, isKept, moveDir, ask, main } = require('./lib');

const NM = `${mod.appDir}/node_modules`;

main(async () => {
  const lastFile = path.join(__dirname, 'LAST_BACKUP.txt');
  const backup = process.argv[2] || (fs.existsSync(lastFile) && fs.readFileSync(lastFile, 'utf8').trim());
  const infoFile = backup && path.join(backup, 'BACKUP.json');
  if (!infoFile || !fs.existsSync(infoFile)) throw new Error('No backup given / found — pass the backup folder: rollback.bat E:\\backups\\...');
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  const current = readRelease(ROOT);
  await assertStopped(readEnv(ROOT));

  console.log(`${mod.name}: now ${current ? current.version : '?'} — back to ${info.from} (backup of ${info.date})`);
  if ((await ask('Put the OLD CODE back? Type YES: ')) !== 'YES') { console.log('Nothing changed.'); return; }
  const restoreDb = (await ask(`Also put the DATABASE "${info.database}" back as it was before the update?\n` +
    'Everything entered in this module since the update is LOST. Type YES to restore it, Enter to keep today\'s data: ')) === 'YES';

  // Code: remove the new version's files, put the old ones back
  for (const rel of current ? current.files : []) {
    if (!isKept(rel)) fs.rmSync(path.join(ROOT, rel), { force: true });
  }
  if (info.nodeModules && fs.existsSync(path.join(backup, 'code', NM))) {
    fs.rmSync(path.join(ROOT, NM), { recursive: true, force: true });
    moveDir(path.join(backup, 'code', NM), path.join(ROOT, NM));
  }
  fs.cpSync(path.join(backup, 'code'), ROOT, { recursive: true });
  console.log('Old code is back.');

  if (restoreDb) {
    const cfg = dbConfig(readEnv(ROOT));
    const { Client } = appRequire(ROOT, 'pg');
    const admin = new Client({ ...cfg, database: 'postgres' });
    await admin.connect();
    const q = `"${cfg.database.replace(/"/g, '""')}"`;
    await admin.query(`DROP DATABASE IF EXISTS ${q} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${q}`);
    await admin.end();
    run(pgTool('pg_restore'), ['-h', cfg.host, '-p', String(cfg.port), '-U', cfg.user, '-d', cfg.database, '--no-owner', path.join(backup, 'database.dump')],
      { env: { ...process.env, PGPASSWORD: cfg.password } });
    console.log(`Database "${cfg.database}" is back as it was on ${info.date}.`);
  }
  console.log(`\nRollback done. Start it again: deploy\\production\\step2_start_${mod.name.toLowerCase()}.bat`);
});
