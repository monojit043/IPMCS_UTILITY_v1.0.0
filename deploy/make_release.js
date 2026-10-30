// Builds a production package of this module from the COMMITTED code (development PC only):
//   node deploy/make_release.js [--with-modules]
// -> D:\ePULSE_releases\<module>\<module>_<date>_<commit>[_full].zip  (upload it to Drive)
// Only files tracked by git go in — never .env, uploads, drawings or test data.
// node_modules (production dependencies, fresh `npm ci`) go in when package-lock.json changed
// since the last package, on the first package, or with --with-modules ("_full" in the name).
// The same zip installs (first time) or updates the module — deploy/production/README.md.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mod, run, stamp, sha256, main } = require('./production/lib');

const ROOT = path.join(__dirname, '..');
const TAR = 'C:\\Windows\\System32\\tar.exe';
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

main(async () => {
  if (git('status', '--porcelain')) throw new Error('Uncommitted changes — commit them first (production must equal a commit).');
  const commit = git('rev-parse', '--short', 'HEAD');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const files = git('ls-files').split('\n').filter(Boolean);
  const lockHash = sha256(execFileSync('git', ['show', `HEAD:${mod.appDir}/package-lock.json`], { cwd: ROOT }));

  const outBase = process.env.RELEASES_DIR || path.join('D:\\ePULSE_releases', mod.name);
  fs.mkdirSync(outBase, { recursive: true });
  const lastFile = path.join(outBase, 'last_release.json');
  const last = fs.existsSync(lastFile) ? JSON.parse(fs.readFileSync(lastFile, 'utf8')) : null;
  const withModules = process.argv.includes('--with-modules') || !last || last.lockHash !== lockHash;

  const version = `${mod.name}_${stamp()}_${commit}${withModules ? '_full' : ''}`;
  const staging = path.join(outBase, version);
  if (fs.existsSync(staging)) throw new Error(`${staging} already exists`);
  fs.mkdirSync(staging);

  console.log(`Packing ${files.length} files of ${commit} (${branch}) ...`);
  const tarFile = `${staging}.tar`;
  run('git', ['archive', '--format=tar', '-o', tarFile, 'HEAD'], { cwd: ROOT });
  run(TAR, ['-x', '-f', tarFile, '-C', staging]);
  fs.rmSync(tarFile);
  for (const d of mod.emptyDirs) fs.mkdirSync(path.join(staging, d), { recursive: true });

  if (withModules) {
    console.log('Installing production node_modules (npm ci --omit=dev) ...');
    run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: path.join(staging, mod.appDir), shell: true });
  }
  for (const x of mod.releaseExtras || []) run(process.execPath, [path.join(ROOT, x.script), staging], { cwd: path.join(ROOT, mod.appDir) });

  const release = { module: mod.name, version, commit, branch, date: new Date().toISOString(), lockHash, withModules, files };
  fs.writeFileSync(path.join(staging, 'RELEASE.json'), JSON.stringify(release, null, 2));

  const zip = `${staging}.zip`;
  console.log('Zipping ...');
  run(TAR, ['-a', '-c', '-f', zip, '-C', outBase, version]);
  fs.writeFileSync(lastFile, JSON.stringify({ version, commit, lockHash, date: release.date }, null, 2));
  console.log(`\nPackage: ${zip}  (${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)${withModules ? '  — includes node_modules' : ''}`);
});
