const authService = require('../services/auth.service');

// Every API call works in one job + unit: the session's job and the unit the
// page sends as X-Unit-No (or the session's starting unit). The employee must
// be on that unit's team — Lead (GL / SGL on PC-2), Material Lead or JE in
// IPMCS — and req.user.role becomes their role THERE (LEAD / ML / JE).
// Short cache, cleared whenever a team changes.
const CACHE_MS = 60 * 1000;
const cache = new Map();   // "EMPID|jobNo" → { at, units: [{ unitNo, role }] }

async function unitsFor(empId, jobNo) {
  const key = `${String(empId).toUpperCase()}|${jobNo}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.units;
  const units = await authService.getUnitsForJob(empId, jobNo);
  cache.set(key, { at: Date.now(), units });
  return units;
}

function clearAccessCache() {
  cache.clear();
}

async function applyUnit(req, res, next) {
  try {
    const unitNo = String(req.get('X-Unit-No') || req.user.unitNo || '').trim();
    const here = (await unitsFor(req.user.empId, req.user.jobNo)).find((u) => u.unitNo === unitNo);
    if (!here) {
      return res.status(403).json({ error: `You are not on the IPMCS team of job ${req.user.jobNo} unit ${unitNo || '—'} — ask its Material Lead or GL` });
    }
    req.user = { ...req.user, unitNo, role: here.role };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { applyUnit, unitsFor, clearAccessCache };
