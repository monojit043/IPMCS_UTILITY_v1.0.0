const HttpError = require('../middlewares/HttpError');
const foldersService = require('../services/pidFolders.service');
const pimsPid = require('../services/pimsPid.service');

async function list(req, res) {
  res.json(await foldersService.getAll());
}

async function create(req, res) {
  const name = (req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'Folder name is required');
  const folder = await foldersService.create(name, req.user.id);
  res.status(201).json(folder);
}

// Resolves each selected PIMS P&ID sheet to its current file revision —
// always live, so the folder reflects PIMS's latest revision automatically.
async function listDocuments(req, res) {
  const masterIndexIds = await foldersService.getSelections(req.params.folderId);
  const docs = await Promise.all(masterIndexIds.map((id) => pimsPid.getCurrentDocument(id)));
  res.json(docs.filter(Boolean));
}

async function addSelection(req, res) {
  const masterIndexId = Number(req.body.masterIndexId);
  if (!masterIndexId) throw new HttpError(400, 'masterIndexId is required');
  const doc = await pimsPid.getCurrentDocument(masterIndexId);
  if (!doc) throw new HttpError(404, 'No current PIMS document for that P&ID');
  await foldersService.addSelection(req.params.folderId, masterIndexId, req.user.id);
  res.status(201).json(doc);
}

async function removeSelection(req, res) {
  await foldersService.removeSelection(req.params.folderId, req.params.masterIndexId);
  res.status(204).end();
}

module.exports = { list, create, listDocuments, addSelection, removeSelection };
