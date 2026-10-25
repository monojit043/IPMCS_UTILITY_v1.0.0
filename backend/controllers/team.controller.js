const HttpError = require('../middlewares/HttpError');
const team = require('../services/team.service');

// The team of the job + unit being worked in (req.user.role is the role there)
const scope = (req) => ({ jobNo: req.user.jobNo, unitNo: req.user.unitNo, actor: { empId: req.user.empId, role: req.user.role } });
const asHttp = (err) => (err instanceof team.TeamError ? new HttpError(err.status, err.message) : err);

async function getTeam(req, res) {
  const t = await team.getTeam(req.user.jobNo, req.user.unitNo);
  res.json({ ...t, myRole: req.user.role, canAssign: { ML: req.user.role === 'LEAD', JE: ['LEAD', 'ML'].includes(req.user.role) } });
}

async function searchEmployees(req, res) {
  if (!['LEAD', 'ML'].includes(req.user.role)) throw new HttpError(403, 'Only the GL / SGL or a Material Lead can add people');
  res.json(await team.searchEmployees(req.query.q));
}

async function assign(req, res) {
  const { empId, role } = req.body || {};
  if (!empId) throw new HttpError(400, 'empId is required');
  try { res.json(await team.assign({ ...scope(req), empId, role })); } catch (err) { throw asHttp(err); }
}

async function remove(req, res) {
  try { res.json(await team.remove({ ...scope(req), empId: req.params.empId })); } catch (err) { throw asHttp(err); }
}

module.exports = { getTeam, searchEmployees, assign, remove };
