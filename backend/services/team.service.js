const { pool, query, queryEpulse } = require('../config/db');
const { pimsLeads, namesFor } = require('./auth.service');
const { clearAccessCache } = require('../middlewares/unit');

// The IPMCS team of one job + unit:
//   Leads — GL of the job + unit / SGL of the job, live from PC-2 (read-only here)
//   ML    — Material Leads: appointed (and removed) by a Lead
//   JE    — Job Engineers: added (and removed) by a Lead or a Material Lead
// Every change is written to ipmcs_assignment_log.

class TeamError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const up = (v) => String(v || '').toUpperCase();

async function getTeam(jobNo, unitNo) {
  const [leads, { rows: members }, { rows: log }] = await Promise.all([
    pimsLeads({ jobNo, unitNo }),
    query(`SELECT emp_id AS "empId", role, assigned_by AS "assignedBy", updated_at AS "assignedAt"
           FROM ipmcs_user_assignments WHERE job_no = $1 AND unit_no = $2 ORDER BY role, emp_id`, [jobNo, unitNo]),
    query(`SELECT emp_id AS "empId", action, old_role AS "oldRole", new_role AS "newRole", done_by AS "doneBy", done_at AS "doneAt"
           FROM ipmcs_assignment_log WHERE job_no = $1 AND unit_no = $2 ORDER BY done_at DESC, id DESC LIMIT 50`, [jobNo, unitNo]),
  ]);
  const leadVia = new Map();
  leads.forEach((l) => leadVia.set(up(l.empId), [...new Set([...(leadVia.get(up(l.empId)) || []), l.via])]));
  const names = await namesFor([...leadVia.keys(), ...members.map((m) => m.empId), ...members.map((m) => m.assignedBy),
    ...log.map((l) => l.empId), ...log.map((l) => l.doneBy)]);
  const nm = (e) => names.get(up(e)) || e;
  return {
    leads: [...leadVia.entries()].map(([empId, via]) => ({ empId, name: nm(empId), via: via.sort().join(' + ') }))
      .sort((a, b) => a.empId.localeCompare(b.empId)),
    members: members.map((m) => ({ ...m, name: nm(m.empId), assignedByName: nm(m.assignedBy) })),
    log: log.map((l) => ({ ...l, name: nm(l.empId), doneByName: nm(l.doneBy) })),
  };
}

// Active employees on PC-2 matching an ID or name (for adding to the team)
async function searchEmployees(q) {
  const s = String(q || '').trim();
  if (s.length < 2) return [];
  const { rows } = await queryEpulse(
    `SELECT id AS "empId", name, department FROM pc2_emp.users
     WHERE is_active = 1 AND (id ILIKE $1 OR name ILIKE $1) ORDER BY name LIMIT 20`,
    [`%${s}%`]
  );
  return rows;
}

function mayAssign(actorRole, newRole, currentRole) {
  if (actorRole === 'LEAD') return ['ML', 'JE'].includes(newRole);
  if (actorRole === 'ML') return newRole === 'JE' && currentRole !== 'ML';
  return false;
}

// Add someone to the team or change their role
async function assign({ jobNo, unitNo, actor, empId, role }) {
  if (!['ML', 'JE'].includes(role)) throw new TeamError(400, 'Role must be ML (Material Lead) or JE');
  const [emp] = (await queryEpulse(`SELECT id, name FROM pc2_emp.users WHERE upper(id) = upper($1) AND is_active = 1`, [empId])).rows;
  if (!emp) throw new TeamError(400, `${empId} is not an active employee on PC-2`);
  if ((await pimsLeads({ empId: emp.id, jobNo, unitNo })).length) {
    throw new TeamError(400, `${emp.name} is already a Lead of this unit (GL / SGL on PC-2)`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [cur] } = await client.query(
      `SELECT role FROM ipmcs_user_assignments WHERE upper(emp_id) = upper($1) AND job_no = $2 AND unit_no = $3 FOR UPDATE`,
      [emp.id, jobNo, unitNo]);
    if (!mayAssign(actor.role, role, cur && cur.role)) {
      throw new TeamError(403, actor.role === 'ML'
        ? 'A Material Lead can only add or change Job Engineers'
        : 'Only the GL / SGL or a Material Lead of this unit can change its team');
    }
    if (cur && cur.role === role) { await client.query('ROLLBACK'); return { changed: false }; }
    if (cur) {
      await client.query(`UPDATE ipmcs_user_assignments SET role = $4, assigned_by = $5, updated_at = now()
                          WHERE upper(emp_id) = upper($1) AND job_no = $2 AND unit_no = $3`, [emp.id, jobNo, unitNo, role, actor.empId]);
    } else {
      await client.query(`INSERT INTO ipmcs_user_assignments (emp_id, job_no, unit_no, role, assigned_by) VALUES ($1,$2,$3,$4,$5)`,
        [emp.id, jobNo, unitNo, role, actor.empId]);
    }
    await client.query(`INSERT INTO ipmcs_assignment_log (job_no, unit_no, emp_id, action, old_role, new_role, done_by)
                        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [jobNo, unitNo, emp.id, cur ? 'change' : 'add', cur ? cur.role : null, role, actor.empId]);
    await client.query('COMMIT');
    clearAccessCache();
    return { changed: true, empId: emp.id, name: emp.name, role, previous: cur ? cur.role : null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Remove someone from the team (a Lead: anyone; a Material Lead: JEs only; never yourself)
async function remove({ jobNo, unitNo, actor, empId }) {
  if (up(empId) === up(actor.empId)) throw new TeamError(400, 'You cannot remove yourself — ask the GL / SGL');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [cur] } = await client.query(
      `SELECT emp_id, role FROM ipmcs_user_assignments WHERE upper(emp_id) = upper($1) AND job_no = $2 AND unit_no = $3 FOR UPDATE`,
      [empId, jobNo, unitNo]);
    if (!cur) throw new TeamError(404, `${empId} is not on the IPMCS team of this unit`);
    const ok = actor.role === 'LEAD' || (actor.role === 'ML' && cur.role === 'JE');
    if (!ok) throw new TeamError(403, actor.role === 'ML' ? 'A Material Lead can only remove Job Engineers' : 'Only the GL / SGL or a Material Lead can change the team');
    await client.query(`DELETE FROM ipmcs_user_assignments WHERE upper(emp_id) = upper($1) AND job_no = $2 AND unit_no = $3`, [empId, jobNo, unitNo]);
    await client.query(`INSERT INTO ipmcs_assignment_log (job_no, unit_no, emp_id, action, old_role, new_role, done_by)
                        VALUES ($1,$2,$3,'remove',$4,NULL,$5)`, [jobNo, unitNo, cur.emp_id, cur.role, actor.empId]);
    await client.query('COMMIT');
    clearAccessCache();
    return { removed: true, empId: cur.emp_id, role: cur.role };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getTeam, searchEmployees, assign, remove, TeamError };
