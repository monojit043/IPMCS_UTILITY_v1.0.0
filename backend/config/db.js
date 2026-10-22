const { Pool } = require('pg');

const baseConfig = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
};

const pool = new Pool({ ...baseConfig, database: process.env.DB_NAME });

// Read-only pools onto the two other databases on the same Postgres server:
// employee identity/credentials, and PIMS project/unit role assignments.
const masterEmployeePool = new Pool({ ...baseConfig, database: process.env.MASTER_EMPLOYEE_DB_NAME });
const pimsPool = new Pool({ ...baseConfig, database: process.env.PIMS_DB_NAME });

for (const p of [pool, masterEmployeePool, pimsPool]) {
  p.on('error', (err) => {
    console.error('Unexpected error on idle Postgres client', err);
  });
}

module.exports = {
  pool,
  masterEmployeePool,
  pimsPool,
  query: (text, params) => pool.query(text, params),
  queryMasterEmployee: (text, params) => masterEmployeePool.query(text, params),
  queryPims: (text, params) => pimsPool.query(text, params),
};
