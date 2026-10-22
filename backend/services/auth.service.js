const jwt = require('jsonwebtoken');
const { query, queryMasterEmployee, queryPims } = require('../config/db');

const SESSION_EXPIRY = '12h';
const PRE_AUTH_EXPIRY = '5m';

// Credentials and display name live in MASTER_EMPLOYEE_DB, outside our own
// database. Passwords are stored there as plain text (not our schema to
// change), so this is a direct string comparison rather than a hash check.
async function verifyCredentials(empId, password) {
  const { rows } = await queryMasterEmployee(
    `SELECT employee_id AS "empId", name, password FROM employee_details WHERE employee_id = $1`,
    [empId]
  );
  const employee = rows[0];
  if (!employee || employee.password !== password) return null;
  return { empId: employee.empId, name: employee.name };
}

// ADMIN/JE is IPMCS-specific and lives in our own database. Anyone without
// an explicit row here is treated as a plain JE.
async function getIpmcsRole(empId) {
  const { rows } = await query(`SELECT role FROM user_assignments WHERE emp_id = $1`, [empId]);
  return rows[0] ? rows[0].role : 'JE';
}

// A user can be assigned to several job_no + unit_no combinations in PIMS
// (one row per PIMS role, e.g. Modeller/Checker/GL, for the same project+unit
// — we only care about the distinct project+unit pairs here).
async function getAssignments(empId) {
  const { rows } = await queryPims(
    `SELECT DISTINCT ura.project_id AS "jobNo", ura.unit_no AS "unitNo", p.name AS "jobName"
     FROM user_role_assignments ura
     LEFT JOIN projects p ON p.id = ura.project_id
     WHERE ura.user_id = $1
     ORDER BY 1, 2`,
    [empId]
  );
  return rows;
}

async function upsertLocalUser(empId, name) {
  const { rows } = await query(
    `INSERT INTO users (emp_id, name) VALUES ($1,$2)
     ON CONFLICT (emp_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id`,
    [empId, name]
  );
  return rows[0].id;
}

function generateToken({ id, empId, name, role, jobNo, unitNo, jobName }) {
  return jwt.sign(
    { id, empId, name, role, jobNo: jobNo || null, unitNo: unitNo || null, jobName: jobName || null },
    process.env.JWT_SECRET,
    { expiresIn: SESSION_EXPIRY }
  );
}

function generatePreAuthToken({ empId, name, role, assignments }) {
  return jwt.sign(
    { purpose: 'assignment-selection', empId, name, role, assignments },
    process.env.JWT_SECRET,
    { expiresIn: PRE_AUTH_EXPIRY }
  );
}

function verifyPreAuthToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (payload.purpose !== 'assignment-selection') throw new Error('Invalid token');
  return payload;
}

module.exports = {
  verifyCredentials,
  getIpmcsRole,
  getAssignments,
  upsertLocalUser,
  generateToken,
  generatePreAuthToken,
  verifyPreAuthToken,
};
