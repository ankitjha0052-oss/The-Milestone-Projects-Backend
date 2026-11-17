const express = require("express");
const { getItems, createItem } = require("../controllers/item.controller");
const authMiddleware = require("../middleware/auth.middleware");
const validateRequest = require("../middleware/validate.middleware");
const { getItemsSchema } = require("../validators/auth.validator");

const router = express.Router();

router.use(authMiddleware);

router.get("/", validateRequest({ query: getItemsSchema }), getItems);
router.post("/", createItem);

module.exports = router;
