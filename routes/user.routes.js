const express = require("express");
const { getMe, updateMe } = require("../controllers/user.controller");
const authMiddleware = require("../middleware/auth.middleware");
const validateRequest = require("../middleware/validate.middleware");
const { updateProfileSchema } = require("../validators/auth.validator");

const router = express.Router();

router.use(authMiddleware);

router.get("/", getMe);
router.patch("/", validateRequest({ body: updateProfileSchema }), updateMe);

module.exports = router;
