const express = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const { requireRole } = require('../middlewares/auth');
const { requireFolder } = require('../middlewares/folder');
const foldersController = require('../controllers/pidFolders.controller');
const pimsPidController = require('../controllers/pimsPid.controller');
const highlightsController = require('../controllers/pidHighlights.controller');

const router = express.Router();

// MTO folders: the ML picks P&IDs, then freezes the folder — that copies
// each one's current revision PDF into IPMCS. MTO is taken only in frozen folders.
router.get('/folders', asyncHandler(foldersController.list));
router.post('/folders', requireRole('LEAD', 'ML'), asyncHandler(foldersController.create));
router.post('/folders/:folderId/freeze', requireRole('LEAD', 'ML'), asyncHandler(foldersController.freeze));

router.get('/folders/:folderId/documents', asyncHandler(foldersController.listDocuments));
router.post('/folders/:folderId/selections', requireRole('LEAD', 'ML'), asyncHandler(foldersController.addSelection));
router.delete(
  '/folders/:folderId/selections/:masterIndexId',
  requireRole('LEAD', 'ML'),
  asyncHandler(foldersController.removeSelection)
);

// Live ePULSE lookups — the "tick which P&IDs to add" list (current
// revisions) and the preview of an open folder's P&IDs.
router.get('/pims/available', asyncHandler(pimsPidController.listAvailable));
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
