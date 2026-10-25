require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { pool, epulsePool, query } = require('../config/db');

// Employee ID made IPMCS ADMIN on a brand-new install (must exist on PC-2).
// Only seeded while the Admin list is completely empty, so removing someone
// from the list later is never undone by re-running this script.
const SEED_ADMIN_EMP_ID = '1234';

async function run() {
  console.log('Running schema.sql ...');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(schema);

  const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM ipmcs_user_assignments WHERE role = 'ADMIN'`);
  if (n === 0) {
    await query(`INSERT INTO ipmcs_user_assignments (emp_id, role) VALUES ($1, 'ADMIN') ON CONFLICT (emp_id) DO NOTHING`, [SEED_ADMIN_EMP_ID]);
    console.log(`No Admin yet — made ${SEED_ADMIN_EMP_ID} IPMCS ADMIN.`);
  } else {
    console.log(`Admin list has ${n} Admin(s) — left as is.`);
  }

  console.log('Done.');
  await Promise.all([pool.end(), epulsePool.end()]);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
