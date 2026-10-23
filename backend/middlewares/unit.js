const authService = require('../services/auth.service');

// The unit being worked in can be switched without logging in again: the
// page sends it as an X-Unit-No header. It must be one of the user's units
// for the session's job, read live from PC-2 (short cache, so a few seconds
// after PIMS changes an assignment it takes effect here).
const CACHE_MS = 60 * 1000;
const cache = new Map();   // "empId|jobNo" → { at, units }

async function unitsFor(empId, jobNo) {
  const key = `${String(empId).toUpperCase()}|${jobNo}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.units;
  const units = await authService.getUnitsForJob(empId, jobNo);
  cache.set(key, { at: Date.now(), units });
  return units;
}

async function applyUnit(req, res, next) {
  try {
    const wanted = String(req.get('X-Unit-No') || '').trim();
    if (!wanted || wanted === req.user.unitNo) return next();
    const units = await unitsFor(req.user.empId, req.user.jobNo);
    if (!units.includes(wanted)) {
      return res.status(403).json({ error: `You are not assigned to unit ${wanted} on job ${req.user.jobNo}` });
    }
    req.user = { ...req.user, unitNo: wanted };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { applyUnit, unitsFor };
