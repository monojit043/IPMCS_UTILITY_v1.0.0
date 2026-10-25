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

// ── Who may work where, and as what (per job + unit) ──
//   LEAD — GL of the job + unit, or SGL of the job (all its units), live from PC-2
//   ML   — Material Lead, appointed in IPMCS (ipmcs_user_assignments)
//   JE   — Job Engineer, added in IPMCS
// Only these people can open a job + unit in IPMCS.
const ROLE_RANK = { LEAD: 3, ML: 2, JE: 1 };

// Leads of PC-2: [{ jobNo, unitNo, empId, via: 'GL' | 'SGL' }]
async function pimsLeads({ empId, jobNo, unitNo } = {}) {
  const { rows } = await queryEpulse(
    `SELECT project_id AS "jobNo", unit_no AS "unitNo", user_id AS "empId", 'GL' AS via
     FROM user_role_assignments
     WHERE role = 'GL' AND ($1::text IS NULL OR upper(user_id) = upper($1))
       AND ($2::text IS NULL OR project_id = $2) AND ($3::text IS NULL OR unit_no = $3)
     UNION
     SELECT pu.project_id, pu.unit_no, s.user_id, 'SGL'
     FROM (SELECT project_id, user_id FROM user_role_assignments WHERE role = 'SGL'
           UNION SELECT project_id, user_id FROM project_sgls) s
     JOIN project_units pu ON pu.project_id = s.project_id
     WHERE ($1::text IS NULL OR upper(s.user_id) = upper($1))
       AND ($2::text IS NULL OR pu.project_id = $2) AND ($3::text IS NULL OR pu.unit_no = $3)`,
    [empId || null, jobNo || null, unitNo || null]
  );
  return rows;
}

// Every job + unit the employee may open, with the role there
async function getAccess(empId) {
  const [leads, { rows: team }, { rows: jobs }] = await Promise.all([
    pimsLeads({ empId }),
    query(`SELECT job_no AS "jobNo", unit_no AS "unitNo", role FROM ipmcs_user_assignments WHERE upper(emp_id) = upper($1)`, [empId]),
    queryEpulse(`SELECT id, name FROM projects`),
  ]);
  const jobName = new Map(jobs.map((j) => [j.id, j.name]));
  const byKey = new Map();
  const put = (jobNo, unitNo, role, via) => {
    const k = `${jobNo}|${unitNo}`;
    const cur = byKey.get(k);
    if (!cur || ROLE_RANK[role] > ROLE_RANK[cur.role]) byKey.set(k, { jobNo, unitNo, jobName: jobName.get(jobNo) || null, role, via });
  };
  leads.forEach((l) => put(l.jobNo, l.unitNo, 'LEAD', l.via));
  team.forEach((t) => put(t.jobNo, t.unitNo, t.role, 'IPMCS'));
  return [...byKey.values()].sort((a, b) => a.jobNo.localeCompare(b.jobNo) || a.unitNo.localeCompare(b.unitNo));
}

// Login: the job + units the employee can open (role included)
const getAssignments = getAccess;

// Units the employee can open on one job, with the role in each (Unit dropdown)
async function getUnitsForJob(empId, jobNo) {
  return (await getAccess(empId)).filter((a) => a.jobNo === jobNo).map((a) => ({ unitNo: a.unitNo, role: a.role }));
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

// Names for a set of employee IDs, read live from PC-2 (nothing cached here)
async function namesFor(empIds) {
  const ids = [...new Set(empIds.filter(Boolean).map((e) => String(e).toUpperCase()))];
  if (!ids.length) return new Map();
  const { rows } = await queryEpulse(`SELECT upper(id) AS id, name FROM pc2_emp.users WHERE upper(id) = ANY($1)`, [ids]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

function generateToken({ empId, name, role, jobNo, unitNo, jobName }) {
  return jwt.sign(
    { empId, name, role, jobNo: jobNo || null, unitNo: unitNo || null, jobName: jobName || null },
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
  pimsLeads,
  getAccess,
  ROLE_RANK,
  getAssignments,
  getUnitsForJob,
  jobsFrom,
  namesFor,
  generateToken,
  generatePreAuthToken,
  verifyPreAuthToken,
};
