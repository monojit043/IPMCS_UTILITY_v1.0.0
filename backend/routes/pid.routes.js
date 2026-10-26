const express = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const { requireRole } = require('../middlewares/auth');
const { requireFolder } = require('../middlewares/folder');
const foldersController = require('../controllers/pidFolders.controller');
const pimsPidController = require('../controllers/pimsPid.controller');
const highlightsController = require('../controllers/pidHighlights.controller');

const router = express.Router();

// MTO folders: Freeze takes EVERY P&ID of the unit's index at its current
// revision and copies the PDFs into IPMCS (no hand-picking). MTO is taken
// only in frozen folders.
router.get('/folders', asyncHandler(foldersController.list));
router.post('/folders', requireRole('LEAD', 'ML'), asyncHandler(foldersController.create));
router.post('/folders/:folderId/freeze', requireRole('LEAD', 'ML'), asyncHandler(foldersController.freeze));

router.get('/folders/:folderId/documents', asyncHandler(foldersController.listDocuments));

// Live ePULSE preview of an open folder's P&IDs (current revision).
router.get('/revisions/:revId', asyncHandler(pimsPidController.getRevision));
router.get('/revisions/:revId/file', asyncHandler(pimsPidController.streamRevision));

// A frozen folder's own copies (kept in IPMCS): fresh + highlighted PDF,
// the copy a line is on, and the highlights made on a copy
router.get('/line-document', requireFolder(), asyncHandler(pimsPidController.getForLine));
router.get('/folder-files/:fileId', asyncHandler(pimsPidController.getFile));
router.get('/folder-files/:fileId/pdf', asyncHandler(pimsPidController.streamFile));
router.get('/folder-files/:fileId/highlights', asyncHandler(highlightsController.getAll));
router.get('/folder-files/:fileId/highlights/mine', asyncHandler(highlightsController.getMine));
router.put('/folder-files/:fileId/highlights/mine', asyncHandler(highlightsController.putMine));
router.get('/folder-files/:fileId/zone-breaks', asyncHandler(highlightsController.getZoneBreaks));

module.exports = router;
