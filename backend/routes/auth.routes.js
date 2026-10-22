const express = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const { requireAuth } = require('../middlewares/auth');
const authController = require('../controllers/auth.controller');

const router = express.Router();

router.post('/login', asyncHandler(authController.login));
router.post('/select-assignment', asyncHandler(authController.selectAssignment));
router.get('/me', requireAuth, authController.me);

module.exports = router;
