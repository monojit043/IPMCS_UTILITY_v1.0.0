const HttpError = require('../middlewares/HttpError');
const highlightsService = require('../services/pidHighlights.service');
const folderFiles = require('../services/folderFiles.service');

function pageOf(req) {
  return Number(req.query.page) || 1;
}

// :fileId = an MTO folder's copy of a drawing (mto_folder_files.id) — only of the user's job + unit
async function fileOf(req) {
  const f = await folderFiles.getFile(req.params.fileId);
  if (!f || f.jobNo !== req.user.jobNo || f.unitNo !== req.user.unitNo) throw new HttpError(404, 'P&ID copy not found in this job / unit');
  return { fileId: f.fileId, revDocId: f.documentId, masterIndexId: f.masterIndexId };
}

async function getAll(req, res) {
  res.json(await highlightsService.getAllForDocument(await fileOf(req), pageOf(req)));
}

async function getMine(req, res) {
  res.json({ strokes: await highlightsService.getMine(await fileOf(req), pageOf(req), req.user.empId) });
}

// Saving also rewrites the folder's highlighted PDF copy
async function putMine(req, res) {
  const { strokes } = req.body;
  if (!Array.isArray(strokes)) throw new HttpError(400, 'strokes must be an array');
  const file = await fileOf(req);
  const result = await highlightsService.upsertMine(file, pageOf(req), req.user.empId, strokes);
  await folderFiles.refreshHighlighted(file.fileId);
  res.json({ strokes: result });
}

async function getZoneBreaks(req, res) {
  res.json(await highlightsService.getZoneBreaks(await fileOf(req), pageOf(req)));
}

module.exports = { getAll, getMine, putMine, getZoneBreaks };
