require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { pool, epulsePool, query } = require('../config/db');

// Nothing is seeded: the team of a job + unit starts from its Leads (GL / SGL
// on PC-2, read live), who appoint Material Leads and JEs in IPMCS.
async function run() {
  console.log('Running schema.sql ...');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(schema);
  const { rows: [{ n }] } = await query(`SELECT count(*)::int AS n FROM ipmcs_user_assignments`);
  console.log(`IPMCS team assignments (ML / JE): ${n}`);
  console.log('Done.');
  await Promise.all([pool.end(), epulsePool.end()]);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
