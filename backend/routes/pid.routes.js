const express = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const { requireRole } = require('../middlewares/auth');
const foldersController = require('../controllers/pidFolders.controller');
const pimsPidController = require('../controllers/pimsPid.controller');
const highlightsController = require('../controllers/pidHighlights.controller');

const router = express.Router();

router.get('/folders', asyncHandler(foldersController.list));
router.post('/folders', requireRole('ADMIN'), asyncHandler(foldersController.create));

router.get('/folders/:folderId/documents', asyncHandler(foldersController.listDocuments));
router.post('/folders/:folderId/selections', requireRole('ADMIN'), asyncHandler(foldersController.addSelection));
router.delete(
  '/folders/:folderId/selections/:masterIndexId',
  requireRole('ADMIN'),
  asyncHandler(foldersController.removeSelection)
);

// Live PIMS lookups — admin's "tick which P&IDs to add" list, resolving a
// line to the sheet it's drawn on, and streaming the actual PDF bytes.
router.get('/pims/available', asyncHandler(pimsPidController.listAvailable));
router.get('/pims-file/:masterIndexId', asyncHandler(pimsPidController.streamFile));
router.get('/line-document', asyncHandler(pimsPidController.getForLine));
router.get('/documents/:masterIndexId', asyncHandler(pimsPidController.getOne));

// :id here is a PIMS pid_master_index id (see pid_user_highlights.document_id).
router.get('/documents/:id/highlights', asyncHandler(highlightsController.getAll));
router.get('/documents/:id/highlights/mine', asyncHandler(highlightsController.getMine));
router.put('/documents/:id/highlights/mine', asyncHandler(highlightsController.putMine));
router.get('/documents/:id/zone-breaks', asyncHandler(highlightsController.getZoneBreaks));

module.exports = router;
