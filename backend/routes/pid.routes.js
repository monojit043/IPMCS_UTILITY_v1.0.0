const express = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const { requireRole } = require('../middlewares/auth');
const { requireFolder } = require('../middlewares/folder');
const foldersController = require('../controllers/pidFolders.controller');
const pimsPidController = require('../controllers/pimsPid.controller');
const highlightsController = require('../controllers/pidHighlights.controller');

const router = express.Router();

// MTO folders: the ML picks the latest P&IDs (each pinned at its revision
// of that moment), then freezes the folder — MTO is taken only in frozen ones.
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

// Live ePULSE lookups — the "tick which P&IDs to add" list (current revisions),
// a line's drawing inside the MTO folder, one revision and its PDF.
router.get('/pims/available', asyncHandler(pimsPidController.listAvailable));
router.get('/line-document', requireFolder(), asyncHandler(pimsPidController.getForLine));
router.get('/revisions/:revId', asyncHandler(pimsPidController.getRevision));
router.get('/revisions/:revId/file', asyncHandler(pimsPidController.streamRevision));

// Highlights are per drawing revision (:revId = ePULSE pid_documents.id)
router.get('/revisions/:revId/highlights', asyncHandler(highlightsController.getAll));
router.get('/revisions/:revId/highlights/mine', asyncHandler(highlightsController.getMine));
router.put('/revisions/:revId/highlights/mine', asyncHandler(highlightsController.putMine));
router.get('/revisions/:revId/zone-breaks', asyncHandler(highlightsController.getZoneBreaks));

module.exports = router;
