const HttpError = require('../middlewares/HttpError');
const authService = require('../services/auth.service');
const sso = require('../utils/sso');

// Nothing about the user is stored in IPMCS — the token carries the employee ID
async function finalizeLogin({ empId, name, role, jobNo, unitNo, jobName }) {
  const token = authService.generateToken({ empId, name, role, jobNo, unitNo, jobName });
  return {
    token,
    user: { empId, name, role, jobNo: jobNo || null, unitNo: unitNo || null, jobName: jobName || null },
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
  // Only the job + units the employee is on the IPMCS team of (Lead from PC-2,
  // or ML / JE in IPMCS). Only the job is chosen at login; the unit in the page.
  const assignments = authService.jobsFrom(await authService.getAssignments(employee.empId));
  if (!assignments.length) {
    throw new HttpError(403, 'You are not on the IPMCS team of any job + unit yet — ask the Material Lead or GL of your unit to add you');
  }

  if (assignments.length > 1) {
    const preAuthToken = authService.generatePreAuthToken({
      empId: employee.empId,
      name: employee.name,
      role: null,
      assignments,
    });
    return res.json({ needsSelection: true, preAuthToken, name: employee.name, assignments });
  }

  const chosen = assignments[0];
  const result = await finalizeLogin({
    empId: employee.empId,
    name: employee.name,
    role: chosen.role,
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
    role: match.role,
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
