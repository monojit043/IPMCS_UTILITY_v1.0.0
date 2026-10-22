const express = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const dumpItemsController = require('../controllers/dumpItems.controller');

const router = express.Router();

router.patch('/:id', asyncHandler(dumpItemsController.update));
router.delete('/:id', asyncHandler(dumpItemsController.remove));

module.exports = router;
