require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { pool, masterEmployeePool, pimsPool, query, queryMasterEmployee } = require('../config/db');
const pimsPid = require('../services/pimsPid.service');

// Employee ID that gets seeded as IPMCS ADMIN on first run (must exist in
// MASTER_EMPLOYEE_DB — everyone else defaults to JE until an admin assigns
// them explicitly). Change/add more via the P&ID library once logged in.
const SEED_ADMIN_EMP_ID = '1234';

// Job/unit to look for a real PIMS P&ID to seed the "MTO-1" folder with, so
// there's something to click through on first run. If PIMS has nothing for
// this job/unit yet (or isn't reachable), the folder is just seeded empty.
const SEED_FOLDER_JOB_NO = 'B378';
const SEED_FOLDER_UNIT_NO = '111';

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

  // Local users row for the seed admin, needed as the created_by/uploaded_by
  // FK target below. Name is pulled from MASTER_EMPLOYEE_DB if reachable.
  let adminName = SEED_ADMIN_EMP_ID;
  try {
    const { rows } = await queryMasterEmployee(
      `SELECT name FROM employee_details WHERE employee_id = $1`,
      [SEED_ADMIN_EMP_ID]
    );
    if (rows[0]) adminName = rows[0].name;
  } catch (err) {
    console.warn(`  could not reach MASTER_EMPLOYEE_DB to look up admin name (${err.message}) — using emp_id as name.`);
  }
  const { rows: [adminUser] } = await query(
    `INSERT INTO users (emp_id, name) VALUES ($1,$2)
     ON CONFLICT (emp_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id`,
    [SEED_ADMIN_EMP_ID, adminName]
  );

  const { rows: folderCountRows } = await query('SELECT COUNT(*)::int AS count FROM pid_folders');
  if (folderCountRows[0].count > 0) {
    console.log(`pid_folders already has ${folderCountRows[0].count} row(s) — skipping P&ID library seed.`);
  } else {
    console.log('Seeding P&ID library (MTO-1 folder) ...');
    const { rows: [folder] } = await query(
      `INSERT INTO pid_folders (name, created_by) VALUES ('MTO-1', $1) RETURNING id`,
      [adminUser.id]
    );
    try {
      const available = await pimsPid.listAvailable(SEED_FOLDER_JOB_NO, SEED_FOLDER_UNIT_NO);
      if (available[0]) {
        await query(
          `INSERT INTO pid_folder_selections (folder_id, pims_master_index_id, added_by) VALUES ($1,$2,$3)`,
          [folder.id, available[0].masterIndexId, adminUser.id]
        );
        console.log(`  added ${available[0].pidName} (${SEED_FOLDER_JOB_NO}/${SEED_FOLDER_UNIT_NO}) to MTO-1.`);
      } else {
        console.log(`  no PIMS P&IDs found yet for ${SEED_FOLDER_JOB_NO}/${SEED_FOLDER_UNIT_NO} — folder left empty.`);
      }
    } catch (err) {
      console.warn(`  could not reach PIMS_SQL to seed a P&ID selection (${err.message}) — folder left empty.`);
    }
  }

  console.log('Done.');
  await Promise.all([pool.end(), masterEmployeePool.end(), pimsPool.end()]);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
