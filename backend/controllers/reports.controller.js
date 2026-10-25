const HttpError = require('../middlewares/HttpError');
const reports = require('../services/reports.service');

// GET /api/reports — the reports that can be downloaded
function list(req, res) {
  res.json(Object.entries(reports.REPORTS).map(([type, r]) => ({ type, title: r.title })));
}

// GET /api/reports/:type — CSV for the user's job + current unit
async function download(req, res) {
  const out = await reports.build(req.params.type, req.user.jobNo, req.user.unitNo);
  if (!out) throw new HttpError(404, 'Unknown report');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('X-Report-Rows', String(out.rows));
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Report-Rows');
  res.send(out.csv);
}

module.exports = { list, download };
