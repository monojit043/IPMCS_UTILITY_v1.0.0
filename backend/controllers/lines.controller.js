const HttpError = require('../middlewares/HttpError');
const linesService = require('../services/lines.service');

async function list(req, res) {
  res.json(await linesService.getAllLines(req.user.jobNo, req.user.unitNo));
}

async function getOne(req, res) {
  const line = await linesService.getLineById(req.params.id);
  if (!line) throw new HttpError(404, 'Line not found');
  res.json(line);
}

async function update(req, res) {
  const { status, items } = req.body;
  const line = await linesService.updateLineStatus(req.params.id, status, items);
  if (!line) throw new HttpError(404, 'Line not found');
  res.json(line);
}

async function services(req, res) {
  res.json(await linesService.getServices(req.user.jobNo, req.user.unitNo));
}

async function sequences(req, res) {
  const { service } = req.query;
  if (!service) throw new HttpError(400, 'service is required');
  res.json(await linesService.getSequences(req.user.jobNo, req.user.unitNo, service));
}

async function sublines(req, res) {
  const { service, seq } = req.query;
  if (!service || !seq) throw new HttpError(400, 'service and seq are required');
  res.json(await linesService.getSublines(req.user.jobNo, req.user.unitNo, service, seq));
}

// COSMAS line header (Contr.Code, DRG indicator, batch, …) for a line of the user's own job/unit
async function updateCosmas(req, res) {
  const line = await linesService.getLineById(req.params.id);
  if (!line || line.jobNo !== req.user.jobNo || line.unitNo !== req.user.unitNo) throw new HttpError(404, 'Line not found');
  res.json(await linesService.updateCosmas(req.params.id, req.body || {}));
}

async function zones(req, res) {
  const { service, seq } = req.query;
  if (!service || !seq) throw new HttpError(400, 'service and seq are required');
  res.json(await linesService.getZones(req.user.jobNo, req.user.unitNo, service, seq));
}

async function lookup(req, res) {
  const { service, seq, zone } = req.query;
  if (!service || !seq || !zone) {
    throw new HttpError(400, 'service, seq and zone are required');
  }
  if (!linesService.normalizeZone(zone)) throw new HttpError(400, 'Zone must be 1–3 letters or digits, e.g. A');
  const line = await linesService.resolveLine(req.user.jobNo, req.user.unitNo, service, seq, zone, req.user.empId);
  if (!line) throw new HttpError(404, 'No line matches that Service / Sequence No in the line list or the uploaded P&IDs');
  res.json(line);
}

module.exports = { list, getOne, update, updateCosmas, services, sequences, sublines, zones, lookup };
