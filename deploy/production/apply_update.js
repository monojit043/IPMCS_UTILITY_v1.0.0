// Installs or updates the module from THIS unzipped package:
//   apply_update.bat [target folder]        (default: installDir in deploy\module.json)
// First install: copies the package into the empty target and the .env template; then STEP 1 + 2.
// Update: backs up the database (pg_dump) and the current code into backupRoot, replaces the code
// (never .env, uploads or other data), updates the database tables, and records the new version.
// rollback.bat puts the backup back.
const fs = require('fs');
const path = require('path');
const { ROOT, mod, envFile, readEnv, dbConfig, pgTool, run, runScripts, assertStopped, backupRoot, readRelease,
  isKept, copyFile, moveDir, stamp, main } = require('./lib');

const NM = `${mod.appDir}/node_modules`;

function copyRelease(release, target, { firstInstall }) {
  for (const rel of release.files) {
    const dst = path.join(target, rel);
    if (!firstInstall && isKept(rel) && fs.existsSync(dst)) continue;
    copyFile(path.join(ROOT, rel), dst);
  }
  // anything the package carries besides the git files (starting data, ...), except node_modules
  const tracked = new Set(release.files);
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (rel === NM || rel === 'RELEASE.json') continue;
      if (e.isDirectory()) { fs.mkdirSync(path.join(target, rel), { recursive: true }); walk(rel); }
      else if (!tracked.has(rel) && !(isKept(rel) && fs.existsSync(path.join(target, rel)))) copyFile(path.join(ROOT, rel), path.join(target, rel));
    }
  };
  walk('');
  if (release.withModules) {
    console.log('Copying node_modules ...');
    fs.cpSync(path.join(ROOT, NM), path.join(target, NM), { recursive: true });
  }
  copyFile(path.join(ROOT, 'RELEASE.json'), path.join(target, 'RELEASE.json'));
}

main(async () => {
  const release = readRelease(ROOT);
  if (!release) throw new Error('RELEASE.json missing — run this from an unzipped package made by make_release.js.');
  const target = path.resolve(process.argv[2] || mod.installDir);
  if (target === path.resolve(ROOT)) throw new Error('This is the installed folder — run apply_update.bat from the UNZIPPED NEW package.');
  const installed = fs.existsSync(target) ? readRelease(target) : null;
  console.log(`${mod.name}: package ${release.version}  ->  ${target}`);

  if (!installed) {
    if (fs.existsSync(target) && fs.readdirSync(target).length) {
      throw new Error(`${target} is not empty and has no RELEASE.json — not an installation made from a package. Stopped.`);
    }
    if (!release.withModules) throw new Error('A first install needs a FULL package (name ends in _full).');
    copyRelease(release, target, { firstInstall: true });
    if (!fs.existsSync(envFile(target))) copyFile(path.join(target, 'deploy', 'production', 'env.production.template'), envFile(target));
    console.log(`\nInstalled in ${target}.\nNext: fill ${envFile(target)} (passwords, SSO_SECRET), then run`);
    console.log(`  ${target}\\deploy\\production\\step1_setup_database.bat\n  ${target}\\deploy\\production\\step2_start_${mod.name.toLowerCase()}.bat`);
    return;
  }

  console.log(`Installed now: ${installed.version}`);
  if (installed.commit === release.commit) throw new Error('This version is already installed — nothing to do.');
  if (!release.withModules && installed.lockHash !== release.lockHash) {
    throw new Error('This version needs new libraries but the package has no node_modules — ask for the FULL package (_full).');
  }
  const env = readEnv(target);
  if (!env) throw new Error(`${envFile(target)} not found.`);
  await assertStopped(env);

  // 1. Backup
  const backup = path.join(backupRoot(), `${stamp()}_before_${release.commit}`);
  fs.mkdirSync(backup, { recursive: true });
  const cfg = dbConfig(env);
  console.log(`Backing up database "${cfg.database}" ...`);
  run(pgTool('pg_dump'), ['-h', cfg.host, '-p', String(cfg.port), '-U', cfg.user, '-F', 'c', '-f', path.join(backup, 'database.dump'), cfg.database],
    { env: { ...process.env, PGPASSWORD: cfg.password } });
  console.log('Backing up code ...');
  for (const rel of [...installed.files, 'RELEASE.json']) {
    if (!isKept(rel) && fs.existsSync(path.join(target, rel))) copyFile(path.join(target, rel), path.join(backup, 'code', rel));
  }
  copyFile(envFile(target), path.join(backup, 'env.copy'));
  if (release.withModules && fs.existsSync(path.join(target, NM))) moveDir(path.join(target, NM), path.join(backup, 'code', NM));
  fs.writeFileSync(path.join(backup, 'BACKUP.json'), JSON.stringify({
    module: mod.name, date: new Date().toISOString(), from: installed.version, to: release.version,
    database: cfg.database, nodeModules: release.withModules,
  }, null, 2));

  // 2. Code: remove files the new version no longer has, then copy it in
  const next = new Set(release.files);
  for (const rel of installed.files) {
    if (!next.has(rel) && !isKept(rel)) fs.rmSync(path.join(target, rel), { force: true });
  }
  copyRelease(release, target, { firstInstall: false });
  fs.writeFileSync(path.join(target, 'deploy', 'production', 'LAST_BACKUP.txt'), backup);
  console.log(`Code updated (backup: ${backup}).`);

  // 3. Database tables
  try {
    runScripts(target, mod.migrate, 'tables');
  } catch (err) {
    throw new Error(`${err.message}\nThe code is updated but the database step failed. To go back: deploy\\production\\rollback.bat`);
  }
  console.log(`\nUpdate done: ${installed.version} -> ${release.version}\nStart it again: deploy\\production\\step2_start_${mod.name.toLowerCase()}.bat`);
});
