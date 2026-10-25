const HttpError = require('../middlewares/HttpError');
const foldersService = require('../services/pidFolders.service');
const pimsPid = require('../services/pimsPid.service');

// Folders belong to one job + unit — the one being worked in (req.user.jobNo
// / unitNo, checked against the unit's team by middlewares/unit.js).
async function ownFolder(req) {
  const folder = await foldersService.getFolder(req.params.folderId);
  if (!folder || folder.jobNo !== req.user.jobNo || folder.unitNo !== req.user.unitNo) {
    throw new HttpError(404, 'Folder not found in this job / unit');
  }
  return folder;
}

async function list(req, res) {
  res.json(await foldersService.getAll(req.user.jobNo, req.user.unitNo));
}

async function create(req, res) {
  const name = (req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'Folder name is required');
  if (name.length > 100) throw new HttpError(400, 'Folder name is too long (max 100)');
  const folder = await foldersService.create(req.user.jobNo, req.user.unitNo, name, req.user.empId);
  if (!folder) throw new HttpError(409, `This unit already has a folder named "${name}"`);
  res.status(201).json(folder);
}

// Resolves each selected P&ID sheet to its current file revision —
// always live, so the folder reflects ePULSE's latest revision automatically.
async function listDocuments(req, res) {
  await ownFolder(req);
  const masterIndexIds = await foldersService.getSelections(req.params.folderId);
  const docs = await Promise.all(masterIndexIds.map((id) => pimsPid.getCurrentDocument(id)));
  res.json(docs.filter(Boolean));
}

async function addSelection(req, res) {
  await ownFolder(req);
  const masterIndexId = Number(req.body.masterIndexId);
  if (!masterIndexId) throw new HttpError(400, 'masterIndexId is required');
  const doc = await pimsPid.getCurrentDocument(masterIndexId);
  if (!doc) throw new HttpError(404, 'No current document for that P&ID');
  if (doc.jobNo !== req.user.jobNo || doc.unitNo !== req.user.unitNo) {
    throw new HttpError(400, `${doc.pidName} belongs to ${doc.jobNo} / ${doc.unitNo}, not this unit`);
  }
  await foldersService.addSelection(req.params.folderId, masterIndexId, req.user.empId);
  res.status(201).json(doc);
}

async function removeSelection(req, res) {
  await ownFolder(req);
  await foldersService.removeSelection(req.params.folderId, req.params.masterIndexId);
  res.status(204).end();
}

module.exports = { list, create, listDocuments, addSelection, removeSelection };
