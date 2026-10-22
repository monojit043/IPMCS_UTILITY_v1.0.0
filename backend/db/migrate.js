require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { pool, epulsePool, query, queryEpulse } = require('../config/db');

// Employee ID that gets seeded as IPMCS ADMIN on first run (must exist on
// PC-2 — everyone else defaults to JE until an admin assigns them explicitly).
const SEED_ADMIN_EMP_ID = '1234';

async function run() {
  console.log('Running schema.sql ...');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(schema);

  console.log(`Seeding IPMCS ADMIN assignment for emp_id ${SEED_ADMIN_EMP_ID} (idempotent) ...`);
  const { rows: assignmentRows } = await query(
    `INSERT INTO user_assignments (emp_id, role) VALUES ($1,'ADMIN')
     ON CONFLICT (emp_id) DO NOTHING
     RETURNING emp_id`,
    [SEED_ADMIN_EMP_ID]
  );
  if (assignmentRows.length === 0) {
    console.log(`  emp_id ${SEED_ADMIN_EMP_ID} already has an assignment — skipping.`);
  }

  // Local users row for the seed admin (created_by/added_by FK target). Name
  // is read live from PC-2 through ePULSE if reachable.
  let adminName = SEED_ADMIN_EMP_ID;
  try {
    const { rows } = await queryEpulse(`SELECT name FROM pc2_emp.users WHERE upper(id) = upper($1)`, [SEED_ADMIN_EMP_ID]);
    if (rows[0]) adminName = rows[0].name;
  } catch (err) {
    console.warn(`  could not reach PC-2 through ePULSE to look up admin name (${err.message}) — using emp_id as name.`);
  }
  await query(
    `INSERT INTO users (emp_id, name) VALUES ($1,$2)
     ON CONFLICT (emp_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
    [SEED_ADMIN_EMP_ID, adminName]
  );

  console.log('Done.');
  await Promise.all([pool.end(), epulsePool.end()]);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
