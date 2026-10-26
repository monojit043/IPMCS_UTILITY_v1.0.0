const HttpError = require('../middlewares/HttpError');
const pimsPid = require('../services/pimsPid.service');
const folderFiles = require('../services/folderFiles.service');
const { newerRevision } = require('../services/pidFolders.service');

async function listAvailable(req, res) {
  res.json(await pimsPid.listAvailable(req.user.jobNo, req.user.unitNo));
}

// A drawing revision (ePULSE pid_documents.id) of the user's job + unit — the
// preview of an OPEN folder's P&IDs, read from ePULSE
async function ownRevision(req) {
  const doc = await pimsPid.getRevision(req.params.revId);
  if (!doc || doc.jobNo !== req.user.jobNo || doc.unitNo !== req.user.unitNo) throw new HttpError(404, 'P&ID revision not found in this job / unit');
  return doc;
}

async function getRevision(req, res) {
  res.json(await ownRevision(req));
}

async function streamRevision(req, res) {
  const doc = await ownRevision(req);
  const full = pimsPid.uploadPath(doc.filePath);
  if (!full) throw new HttpError(400, 'Invalid file path');
  res.setHeader('Content-Type', 'application/pdf');
  res.sendFile(full, (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'P&ID file not found on disk' }); });
}

// A frozen folder's copy of a drawing, kept in IPMCS
async function ownFile(req) {
  const f = await folderFiles.getFile(req.params.fileId);
  if (!f || f.jobNo !== req.user.jobNo || f.unitNo !== req.user.unitNo) throw new HttpError(404, 'P&ID copy not found in this job / unit');
  return f;
}

async function getFile(req, res) {
  const f = await ownFile(req);
  res.json({ ...f, newerRev: await newerRevision(f.masterIndexId, f.documentId) });
}

// ?kind=fresh|highlighted, &download=1 to save it as a file
async function streamFile(req, res) {
  const f = await ownFile(req);
  const kind = req.query.kind === 'highlighted' ? 'highlighted' : 'fresh';
  const pdf = await folderFiles.getPdf(f.fileId, kind);
  res.setHeader('Content-Type', 'application/pdf');
  if (req.query.download) {
    const name = `${f.pidName}_${f.revLabel || ''}_${f.folderName}_${kind}.pdf`.replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  }
  res.send(pdf);
}

// The folder's copy of the drawing a line is on: ?service=&lsr=&subline=
// (needs the MTO folder, X-Folder-Id)
async function getForLine(req, res) {
  const { service, lsr, subline } = req.query;
  if (!service || !lsr) throw new HttpError(400, 'service and lsr are required');
  const seq = subline ? `${lsr}-${subline}` : lsr;
  const doc = await pimsPid.findForLine(req.user.jobNo, req.user.unitNo, req.folder.drawings, service, seq);
  const file = doc && await folderFiles.fileForRevision(req.folder.id, doc.documentId);
  if (!file) throw new HttpError(404, `This line is not on any P&ID of MTO folder "${req.folder.name}"`);
  res.json(file);
}

module.exports = { listAvailable, getRevision, streamRevision, getFile, streamFile, getForLine };
