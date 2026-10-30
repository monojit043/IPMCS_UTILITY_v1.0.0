// Setup step (run from backend\): imports the standard BoM lists packed in deploy\production\data
// (data\item_list\*.xls, data\assembly_directory\*.xls) with db/importBomList.js.
// A list that is already the current one is left as it is, so running it again changes nothing.
const fs = require('fs');
const path = require('path');
const { run } = require('./lib');

const dataDir = path.join(__dirname, 'data');
const kinds = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
if (!kinds.length) console.log('No standard BoM lists in this package — skipped (import later with npm run import-item-list).');
for (const kind of kinds) {
  for (const f of fs.readdirSync(path.join(dataDir, kind))) {
    run(process.execPath, ['db/importBomList.js', kind, path.join(dataDir, kind, f)]);
  }
}
