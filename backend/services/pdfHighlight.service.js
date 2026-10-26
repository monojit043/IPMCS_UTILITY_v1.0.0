const { PDFDocument, StandardFonts, rgb, LineCapStyle } = require('pdf-lib');

// Draws highlight strokes into a PDF, as the P&ID viewer shows them.
// Strokes are stored in pdf.js viewport units at scale 1 (origin top-left,
// y down, page rotation applied), so each point is mapped back to PDF user
// space through the inverse of that viewport transform.

// Same palette + hashing as public/js/data.js, so the PDF matches the screen
const COLORS = ['#2f7dfa', '#22c58e', '#e8a33d', '#ef5b5b', '#a855f7', '#06b6d4', '#f472b6', '#84cc16'];
function colorOf(key) {
  const s = String(key || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % COLORS.length;
  const hex = COLORS[h];
  return rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
}

// pdf.js PageViewport transform (scale 1) for a page's view box + rotation
function viewportTransform(page) {
  const { x, y, width, height } = page.getCropBox();
  const x0 = x, y0 = y, x1 = x + width, y1 = y + height;
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const [A, Bv, C, D] = { 0: [1, 0, 0, -1], 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] }[rot] || [1, 0, 0, -1];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const [offX, offY] = A === 0 ? [Math.abs(cy - y0), Math.abs(cx - x0)] : [Math.abs(cx - x0), Math.abs(cy - y0)];
  return [A, Bv, C, D, offX - A * cx - C * cy, offY - Bv * cx - D * cy];
}
// viewport (X, Y) → PDF user space (x, y)
function toPdf([a, b, c, d, e, f], X, Y) {
  const det = a * d - b * c;
  return [(d * (X - e) - c * (Y - f)) / det, (-b * (X - e) + a * (Y - f)) / det];
}

// strokes: [{ page (1-based), empId, stroke: { zone, points } | points[] }]
async function renderHighlighted(freshPdf, strokes, footer) {
  const pdf = await PDFDocument.load(freshPdf, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  const labelled = new Set();
  for (const { page: n, empId, stroke } of strokes) {
    const page = pages[n - 1];
    if (!page) continue;
    const zone = Array.isArray(stroke) ? null : stroke.zone || null;
    const points = Array.isArray(stroke) ? stroke : stroke.points || [];
    if (points.length < 2) continue;
    const t = viewportTransform(page);
    const pts = points.map(([X, Y]) => toPdf(t, X, Y));
    const color = zone ? colorOf(zone) : colorOf(empId);
    for (let i = 1; i < pts.length; i++) {
      page.drawLine({
        start: { x: pts[i - 1][0], y: pts[i - 1][1] }, end: { x: pts[i][0], y: pts[i][1] },
        thickness: 11, color, opacity: 0.45, lineCap: LineCapStyle.Round,
      });
    }
    const tag = `${n}|${zone || empId}`;
    if (!labelled.has(tag)) {   // one label per zone (or person) per page
      labelled.add(tag);
      page.drawText(zone ? `Zone ${zone}` : empId, { x: pts[0][0] + 6, y: pts[0][1] + 6, size: 8, font, color });
    }
  }
  if (footer) {
    pages.forEach((page) => {
      const { x, y } = page.getCropBox();
      page.drawText(footer, { x: x + 12, y: y + 8, size: 6, font, color: rgb(0.35, 0.35, 0.35) });
    });
  }
  return Buffer.from(await pdf.save());
}

module.exports = { renderHighlighted, viewportTransform, toPdf };
