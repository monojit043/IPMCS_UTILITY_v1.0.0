const fs = require('fs');
const path = require('path');
const HttpError = require('../middlewares/HttpError');
const pimsPid = require('../services/pimsPid.service');
async function listAvailable(req, res) {
  res.json(await pimsPid.listAvailable(req.user.jobNo, req.user.unitNo));
}

// A drawing revision (ePULSE pid_documents.id) of the user's job + unit
async function ownRevision(req) {
  const doc = await pimsPid.getRevision(req.params.revId);
  if (!doc || doc.jobNo !== req.user.jobNo || doc.unitNo !== req.user.unitNo) throw new HttpError(404, 'P&ID revision not found in this job / unit');
  return doc;
}

async function getRevision(req, res) {
  res.json(await ownRevision(req));
}

// The drawing a line is on, among the MTO folder's pinned revisions:
// ?service=&lsr=&subline= (the line selected in the page). Needs X-Folder-Id.
async function getForLine(req, res) {
  const { service, lsr, subline } = req.query;
  if (!service || !lsr) throw new HttpError(400, 'service and lsr are required');
  const seq = subline ? `${lsr}-${subline}` : lsr;
  const doc = await pimsPid.findForLine(req.user.jobNo, req.user.unitNo, req.folder.scope, service, seq);
  if (!doc) throw new HttpError(404, `No P&ID in MTO folder "${req.folder.name}" for this line`);
  res.json(doc);
}

// The PDF of one drawing revision
async function streamRevision(req, res) {
  const doc = await ownRevision(req);

  // ePULSE's uploads folder — pid_documents.file_path ("B862/101/PID/…pdf") is relative to it
  const root = process.env.EPULSE_UPLOADS_ROOT;
  if (!root) throw new HttpError(500, 'EPULSE_UPLOADS_ROOT is not configured');

  const base = path.resolve(root);
  const fullPath = path.resolve(base, doc.filePath);
  if (!fullPath.startsWith(base + path.sep)) throw new HttpError(400, 'Invalid file path');
  if (!fs.existsSync(fullPath)) throw new HttpError(404, 'P&ID file not found on disk');

  res.setHeader('Content-Type', 'application/pdf');
  res.sendFile(fullPath);
}

module.exports = { listAvailable, getRevision, getForLine, streamRevision };
