const { Pool } = require('pg');

const baseConfig = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
};

// IPMCS's own data: MTO / dump / extracted items, lines being worked on,
// P&ID folders, highlights, the ADMIN list.
const pool = new Pool({ ...baseConfig, database: process.env.DB_NAME });

// ePULSE, READ-ONLY. Everything IPMCS doesn't own is read live from here —
// nothing is copied (except the P&ID PDFs a frozen MTO folder keeps, see
// services/folderFiles.service.js):
//   - login, jobs/units  → pc2_emp.users, user_role_assignments, projects
//                          (ePULSE links these live to PC-2)
//   - line list          → line_list
//   - P&IDs              → pid_master_index, pid_documents, pid_extracted_lines
const epulsePool = new Pool({
  ...baseConfig,
  database: process.env.EPULSE_DB_NAME,
  options: '-c default_transaction_read_only=on',
});

for (const p of [pool, epulsePool]) {
  p.on('error', (err) => {
    console.error('Unexpected error on idle Postgres client', err);
  });
}

module.exports = {
  pool,
  epulsePool,
  query: (text, params) => pool.query(text, params),
  queryEpulse: (text, params) => epulsePool.query(text, params),
};
