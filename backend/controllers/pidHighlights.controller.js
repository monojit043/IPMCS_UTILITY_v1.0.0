const HttpError = require('../middlewares/HttpError');
const highlightsService = require('../services/pidHighlights.service');
const pimsPid = require('../services/pimsPid.service');

function pageOf(req) {
  return Number(req.query.page) || 1;
}

// The drawing revision (ePULSE pid_documents.id) — only one of the user's job + unit
async function revOf(req) {
  const doc = await pimsPid.getRevision(req.params.revId);
  if (!doc || doc.jobNo !== req.user.jobNo || doc.unitNo !== req.user.unitNo) throw new HttpError(404, 'P&ID revision not found in this job / unit');
  return { revDocId: doc.documentId, masterIndexId: doc.masterIndexId };
}

async function getAll(req, res) {
  res.json(await highlightsService.getAllForDocument(await revOf(req), pageOf(req)));
}

async function getMine(req, res) {
  res.json({ strokes: await highlightsService.getMine(await revOf(req), pageOf(req), req.user.empId) });
}

async function putMine(req, res) {
  const { strokes } = req.body;
  if (!Array.isArray(strokes)) throw new HttpError(400, 'strokes must be an array');
  const result = await highlightsService.upsertMine(await revOf(req), pageOf(req), req.user.empId, strokes);
  res.json({ strokes: result });
}

async function getZoneBreaks(req, res) {
  res.json(await highlightsService.getZoneBreaks(await revOf(req), pageOf(req)));
}

module.exports = { getAll, getMine, putMine, getZoneBreaks };
