const HttpError = require('../middlewares/HttpError');
const lineData = require('../services/lineData.service');
const lineZones = require('../services/lineZones.service');
const { namesFor } = require('../services/auth.service');
const summary = require('../services/summary.service');
const reports = require('../services/reports.service');

// Everything here works inside one frozen MTO folder (req.folder, see
// middlewares/folder.js): every line-list line + every line on the latest
// P&IDs is open; the MTO saved belongs to that folder.

// ── Line selection: Service → LSR NO → Subline No. (live from ePULSE) ──
async function services(req, res) {
  res.json(await lineData.getServices(req.user.jobNo, req.user.unitNo, req.folder.scope));
}

async function lsrNos(req, res) {
  const { service } = req.query;
  if (!service) throw new HttpError(400, 'service is required');
  res.json(await lineData.getLsrNos(req.user.jobNo, req.user.unitNo, req.folder.scope, service));
}

async function sublines(req, res) {
  const { service, lsr } = req.query;
  if (!service || !lsr) throw new HttpError(400, 'service and lsr are required');
  res.json(await lineData.getSublines(req.user.jobNo, req.user.unitNo, req.folder.scope, service, lsr));
}

// Line data as soon as Service / Unit / LSR NO / Subline No. are chosen — nothing saved
async function data(req, res) {
  const { service, lsr, subline = '' } = req.query;
  if (!service || !lsr) throw new HttpError(400, 'service and lsr are required');
  const line = await lineData.getLineData(req.user.jobNo, req.user.unitNo, req.folder.scope, service, lsr, subline);
  if (!line) throw new HttpError(404, 'This line is not in the line list or on the latest P&IDs');
  res.json(line);
}

// Zones already saved for the line
async function zones(req, res) {
  const { service, lsr, subline = '' } = req.query;
  if (!service || !lsr) throw new HttpError(400, 'service and lsr are required');
  res.json(await lineZones.zonesForLine(req.user.jobNo, req.user.unitNo, req.folder, service, lsr, subline));
}

// ── Saved line + zones (mto_line_zones) ──
async function listZones(req, res) {
  res.json(await lineZones.listZones(req.user.jobNo, req.user.unitNo, req.folder));
}

async function getZone(req, res) {
  await ownZone(req);
  const full = await lineZones.getZoneFull(req.params.id, req.folder);
  res.json(full);
}

// Only zones of the user's own job / unit and of the MTO folder being worked in
async function ownZone(req) {
  const zone = await lineZones.getZone(req.params.id);
  if (!zone || zone.jobNo !== req.user.jobNo || zone.unitNo !== req.user.unitNo || zone.folderId !== req.folder.id) {
    throw new HttpError(404, 'Line zone not found in this MTO folder');
  }
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
      jobNo: req.user.jobNo, unitNo: req.user.unitNo, empId: req.user.empId, folder: req.folder,
      service, lsrNo, sublineNo: sublineNo || '', zone, header, kind, rows: rows || [],
    }));
  } catch (err) {
    if (err instanceof lineZones.InputError) throw new HttpError(400, err.message);
    throw err;
  }
}

// Search/Delete Lines/Print: every line + zone with MTO taken in the unit
async function searchZones(req, res) {
  res.json(await reports.overview(req.user.jobNo, req.user.unitNo, req.folder));
}

// Delete a line + zone (archived first). Allowed for whoever created or last
// saved it, or an IPMCS Admin.
async function deleteZone(req, res) {
  const zone = await ownZone(req);
  const me = String(req.user.empId).toUpperCase();
  const mine = [zone.createdBy, zone.updatedBy].some((e) => String(e || '').toUpperCase() === me);
  if (!mine && !['LEAD', 'ML'].includes(req.user.role)) throw new HttpError(403, 'Only the engineer who saved this line + zone, or the Material Lead / GL of the unit, can delete it');
  const out = await lineZones.deleteZone(zone.id, req.user.empId, (req.body && req.body.reason) || null);
  if (!out) throw new HttpError(404, 'Line zone not found');
  res.json({ ok: true, ...out });
}

// MTO Summary: ePULSE zone plan vs IPMCS MTO taken, for the unit
async function getSummary(req, res) {
  res.json(await summary.getSummary(req.user.jobNo, req.user.unitNo, req.folder));
}

module.exports = { searchZones, deleteZone, getSummary, services, lsrNos, sublines, data, zones, listZones, getZone, saveZone, listRevisions, getRevision };
