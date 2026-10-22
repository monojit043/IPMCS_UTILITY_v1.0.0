const HttpError = require('../middlewares/HttpError');
const authService = require('../services/auth.service');

async function finalizeLogin({ empId, name, role, jobNo, unitNo, jobName }) {
  const id = await authService.upsertLocalUser(empId, name);
  const token = authService.generateToken({ id, empId, name, role, jobNo, unitNo, jobName });
  return {
    token,
    user: { id, empId, name, role, jobNo: jobNo || null, unitNo: unitNo || null, jobName: jobName || null },
  };
}

async function login(req, res) {
  const { empId, password } = req.body;
  if (!empId || !password) throw new HttpError(400, 'Employee ID and password are required');

  const employee = await authService.verifyCredentials(empId, password);
  if (!employee) throw new HttpError(401, 'Invalid employee ID or password');

  const role = await authService.getIpmcsRole(employee.empId);
  const assignments = await authService.getAssignments(employee.empId);

  if (assignments.length > 1) {
    const preAuthToken = authService.generatePreAuthToken({
      empId: employee.empId,
      name: employee.name,
      role,
      assignments,
    });
    return res.json({ needsSelection: true, preAuthToken, name: employee.name, assignments });
  }

  const chosen = assignments[0] || {};
  const result = await finalizeLogin({
    empId: employee.empId,
    name: employee.name,
    role,
    jobNo: chosen.jobNo,
    unitNo: chosen.unitNo,
    jobName: chosen.jobName,
  });
  res.json(result);
}

async function selectAssignment(req, res) {
  const { preAuthToken, jobNo, unitNo } = req.body;
  if (!preAuthToken || !jobNo || !unitNo) throw new HttpError(400, 'preAuthToken, jobNo and unitNo are required');

  let payload;
  try {
    payload = authService.verifyPreAuthToken(preAuthToken);
  } catch (err) {
    throw new HttpError(401, 'Selection expired — please log in again');
  }

  const match = payload.assignments.find((a) => a.jobNo === jobNo && a.unitNo === unitNo);
  if (!match) throw new HttpError(400, 'That job/unit is not assigned to this user');

  const result = await finalizeLogin({
    empId: payload.empId,
    name: payload.name,
    role: payload.role,
    jobNo: match.jobNo,
    unitNo: match.unitNo,
    jobName: match.jobName,
  });
  res.json(result);
}

function me(req, res) {
  res.json({ user: req.user });
}

module.exports = { login, selectAssignment, me };
