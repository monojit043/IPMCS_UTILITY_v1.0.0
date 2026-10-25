require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { pool, epulsePool, query, queryEpulse } = require('../config/db');

// Nothing is seeded: the team of a job + unit starts from its Leads (GL / SGL
// on PC-2, read live), who appoint Material Leads and JEs in IPMCS.
async function run() {
  console.log('Running schema.sql ...');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(schema);
  const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM ipmcs_user_assignments`);
  console.log(`IPMCS team assignments (ML / JE): ${n}`);

  // P&ID folders made before folders were per job + unit: take the job + unit
  // of the P&IDs in them (read from ePULSE). A folder whose P&IDs disagree, or
  // that is empty, is left unassigned and reported.
  const { rows: loose } = await query(`SELECT id, name FROM pid_folders WHERE job_no IS NULL OR unit_no IS NULL`);
  for (const f of loose) {
    const { rows: sel } = await query(`SELECT pims_master_index_id AS id FROM pid_folder_selections WHERE folder_id = $1`, [f.id]);
    const { rows: scopes } = sel.length
      ? await queryEpulse(`SELECT DISTINCT job_no, unit_no FROM pid_master_index WHERE id = ANY($1)`, [sel.map((s) => s.id)])
      : { rows: [] };
    if (scopes.length === 1) {
      await query(`UPDATE pid_folders SET job_no = $2, unit_no = $3 WHERE id = $1`, [f.id, scopes[0].job_no, scopes[0].unit_no]);
      console.log(`P&ID folder "${f.name}" → ${scopes[0].job_no} / ${scopes[0].unit_no}`);
    } else {
      console.warn(`P&ID folder "${f.name}" (id ${f.id}) has ${scopes.length ? 'P&IDs of several job/units' : 'no P&IDs'} — left without a job/unit; it is not shown until fixed.`);
    }
  }
  console.log('Done.');
  await Promise.all([pool.end(), epulsePool.end()]);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
