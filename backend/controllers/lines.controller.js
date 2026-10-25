const HttpError = require('../middlewares/HttpError');
const lineData = require('../services/lineData.service');
const lineZones = require('../services/lineZones.service');
const { namesFor } = require('../services/auth.service');
const summary = require('../services/summary.service');

// ── Line selection: Service → LSR NO → Subline No. (live from ePULSE) ──
async function services(req, res) {
  res.json(await lineData.getServices(req.user.jobNo, req.user.unitNo));
}

async function lsrNos(req, res) {
  const { service } = req.query;
  if (!service) throw new HttpError(400, 'service is required');
  res.json(await lineData.getLsrNos(req.user.jobNo, req.user.unitNo, service));
}

async function sublines(req, res) {
  const { service, lsr } = req.query;
  if (!service || !lsr) throw new HttpError(400, 'service and lsr are required');
  res.json(await lineData.getSublines(req.user.jobNo, req.user.unitNo, service, lsr));
}

// Line data as soon as Service / Unit / LSR NO / Subline No. are chosen — nothing saved
async function data(req, res) {
  const { service, lsr, subline = '' } = req.query;
  if (!service || !lsr) throw new HttpError(400, 'service and lsr are required');
  const line = await lineData.getLineData(req.user.jobNo, req.user.unitNo, service, lsr, subline);
  if (!line) throw new HttpError(404, 'This line is not in the line list or the uploaded P&IDs');
  res.json(line);
}

// Zones already saved for the line
async function zones(req, res) {
  const { service, lsr, subline = '' } = req.query;
  if (!service || !lsr) throw new HttpError(400, 'service and lsr are required');
  res.json(await lineZones.zonesForLine(req.user.jobNo, req.user.unitNo, service, lsr, subline));
}

// ── Saved line + zones (mto_line_zones) ──
async function listZones(req, res) {
  res.json(await lineZones.listZones(req.user.jobNo, req.user.unitNo));
}

async function getZone(req, res) {
  const full = await lineZones.getZoneFull(req.params.id);
  if (!full || full.zone.jobNo !== req.user.jobNo || full.zone.unitNo !== req.user.unitNo) {
    throw new HttpError(404, 'Line zone not found');
  }
  res.json(full);
}

// Only zones of the user's own job / unit
async function ownZone(req) {
  const zone = await lineZones.getZone(req.params.id);
  if (!zone || zone.jobNo !== req.user.jobNo || zone.unitNo !== req.user.unitNo) throw new HttpError(404, 'Line zone not found');
  return zone;
}

// View History: every saved revision of a line + zone, newest first
async function listRevisions(req, res) {
  await ownZone(req);
  const revs = await lineZones.listRevisions(req.params.id);
  const names = await namesFor(revs.map((r) => r.savedBy));
  res.json(revs.map((r) => ({ ...r, savedByName: names.get(String(r.savedBy || '').toUpperCase()) || r.savedBy })));
}

async function getRevision(req, res) {
  await ownZone(req);
  const rev = await lineZones.getRevision(req.params.id, Number(req.params.rev));
  if (!rev) throw new HttpError(404, 'Revision not found');
  const names = await namesFor([rev.savedBy]);
  res.json({ ...rev, savedByName: names.get(String(rev.savedBy || '').toUpperCase()) || rev.savedBy });
}

async function saveZone(req, res) {
  const { service, lsrNo, sublineNo, zone, header, kind, rows } = req.body || {};
  if (!service || !lsrNo || !zone) throw new HttpError(400, 'service, lsrNo and zone are required');
  try {
    res.json(await lineZones.saveZone({
      jobNo: req.user.jobNo, unitNo: req.user.unitNo, empId: req.user.empId,
      service, lsrNo, sublineNo: sublineNo || '', zone, header, kind, rows: rows || [],
    }));
  } catch (err) {
    if (err instanceof lineZones.InputError) throw new HttpError(400, err.message);
    throw err;
  }
}

// MTO Summary: ePULSE zone plan vs IPMCS MTO taken, for the unit
async function getSummary(req, res) {
  res.json(await summary.getSummary(req.user.jobNo, req.user.unitNo));
}

module.exports = { getSummary, services, lsrNos, sublines, data, zones, listZones, getZone, saveZone, listRevisions, getRevision };
