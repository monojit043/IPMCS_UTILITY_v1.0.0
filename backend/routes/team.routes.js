const express = require('express');
const asyncHandler = require('../middlewares/asyncHandler');
const c = require('../controllers/team.controller');

const router = express.Router();

router.get('/', asyncHandler(c.getTeam));
router.get('/employees', asyncHandler(c.searchEmployees));
router.put('/', asyncHandler(c.assign));
router.delete('/:empId', asyncHandler(c.remove));

module.exports = router;
