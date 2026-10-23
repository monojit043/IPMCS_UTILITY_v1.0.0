const jwt = require('jsonwebtoken');
const { query, queryEpulse } = require('../config/db');

const SESSION_EXPIRY = '12h';
const PRE_AUTH_EXPIRY = '5m';

// Credentials live on PC-2 (eil_employees.users), read live through ePULSE's
// pc2_emp.users link. Passwords there are plain text (not our schema to
// change), so this is a direct comparison. Deactivated employees can't log in.
async function verifyCredentials(empId, password) {
  const { rows } = await queryEpulse(
    `SELECT id AS "empId", name FROM pc2_emp.users
     WHERE upper(id) = upper($1) AND password_hash = $2 AND is_active = 1`,
    [String(empId).trim(), password]
  );
  return rows[0] || null;
}

// Single sign-on: the eil_sso cookie only says WHO is signed in (set by
// ePULSE, MRCS, SSMS or IPMCS itself) — the employee must still exist and be
// active on PC-2.
async function getActiveEmployee(empId) {
  const { rows } = await queryEpulse(
    `SELECT id AS "empId", name FROM pc2_emp.users WHERE upper(id) = upper($1) AND is_active = 1`,
    [String(empId).trim()]
  );
  return rows[0] || null;
}

// ADMIN/JE is IPMCS-specific and lives in our own database. Anyone without
// an explicit row here is treated as a plain JE.
async function getIpmcsRole(empId) {
  const { rows } = await query(`SELECT role FROM user_assignments WHERE upper(emp_id) = upper($1)`, [empId]);
  return rows[0] ? rows[0].role : 'JE';
}

// A user can be assigned to several job_no + unit_no combinations in PIMS
// (one row per PIMS role, e.g. Modeller/Checker/GL, for the same project+unit
// — we only care about the distinct project+unit pairs here). Live from PC-2
// via ePULSE's user_role_assignments / projects views.
async function getAssignments(empId) {
  const { rows } = await queryEpulse(
    `SELECT DISTINCT ura.project_id AS "jobNo", ura.unit_no AS "unitNo", p.name AS "jobName"
     FROM user_role_assignments ura
     LEFT JOIN projects p ON p.id = ura.project_id
     WHERE upper(ura.user_id) = upper($1)
     ORDER BY 1, 2`,
    [empId]
  );
  return rows;
}

// Units the user is assigned to on one job (for the Unit dropdown)
async function getUnitsForJob(empId, jobNo) {
  const { rows } = await queryEpulse(
    `SELECT DISTINCT unit_no FROM user_role_assignments
     WHERE upper(user_id) = upper($1) AND project_id = $2 ORDER BY 1`,
    [empId, jobNo]
  );
  return rows.map((r) => r.unit_no);
}

// Login only asks for the JOB — the unit is picked in the page afterwards.
// One entry per job, carrying its first unit as the starting unit.
function jobsFrom(assignments) {
  const byJob = new Map();
  assignments.forEach((a) => {
    const j = byJob.get(a.jobNo);
    if (j) j.unitCount++;
    else byJob.set(a.jobNo, { ...a, unitCount: 1 });
  });
  return [...byJob.values()];
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
  getActiveEmployee,
  getIpmcsRole,
  getAssignments,
  getUnitsForJob,
  jobsFrom,
  upsertLocalUser,
  generateToken,
  generatePreAuthToken,
  verifyPreAuthToken,
};
