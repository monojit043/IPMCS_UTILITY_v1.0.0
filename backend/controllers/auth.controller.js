const HttpError = require('../middlewares/HttpError');
const authService = require('../services/auth.service');
const sso = require('../utils/sso');

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

  // Logging in here also signs in to ePULSE / MRCS / SSMS (same host)
  sso.setCookie(res, employee.empId);
  await startSession(employee, res);
}

// Arriving from the ePULSE gateway (or any app on the same host) already
// signed in: the eil_sso cookie is enough, no password asked.
async function ssoLogin(req, res) {
  const empId = sso.currentUserId(req);
  if (!empId) throw new HttpError(401, 'Not signed in');
  const employee = await authService.getActiveEmployee(empId);
  if (!employee) {
    sso.clearCookie(res);
    throw new HttpError(401, 'Your account is not active');
  }
  await startSession(employee, res);
}

// Signing out of IPMCS signs out of every app on this host
function logout(req, res) {
  sso.clearCookie(res);
  res.status(204).end();
}

async function startSession(employee, res) {
  const role = await authService.getIpmcsRole(employee.empId);
  // Only the job is chosen at login; the unit is switched in the page
  const assignments = authService.jobsFrom(await authService.getAssignments(employee.empId));

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

// Units the user can switch between on the session's job (live from PC-2)
async function units(req, res) {
  if (!req.user.jobNo) return res.json([]);
  res.json(await authService.getUnitsForJob(req.user.empId, req.user.jobNo));
}

module.exports = { login, ssoLogin, logout, selectAssignment, me, units };
