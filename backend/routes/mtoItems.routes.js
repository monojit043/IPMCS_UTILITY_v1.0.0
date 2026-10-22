const express = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const mtoItemsController = require('../controllers/mtoItems.controller');

const router = express.Router();

router.patch('/:id', asyncHandler(mtoItemsController.update));
router.delete('/:id', asyncHandler(mtoItemsController.remove));

module.exports = router;
