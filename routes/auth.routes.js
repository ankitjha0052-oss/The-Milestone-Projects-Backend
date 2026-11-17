const express = require("express");
const {
  googleLogin,
  appleLogin,
  appleFormCallback,
  refresh,
  logout,
  logoutAll,
  getAppleClientSecret,
} = require("../controllers/auth.controller");
const authMiddleware = require("../middleware/auth.middleware");
const authRateLimiter = require("../middleware/rateLimit.middleware");
const validateRequest = require("../middleware/validate.middleware");
const {
  googleAuthSchema,
  appleAuthSchema,
  appleCallbackSchema,
} = require("../validators/auth.validator");

const router = express.Router();

router.use(authRateLimiter);

// 1. Google Auth
router.post(
  "/google",
  validateRequest({ body: googleAuthSchema }),
  googleLogin
);

// 2. Apple Auth (JSON API)
router.post(
  "/apple",
  validateRequest({ body: appleAuthSchema }),
  appleLogin
);

// Apple Auth (Form POST Callback)
router.post(
  "/apple/callback",
  validateRequest({ body: appleCallbackSchema }),
  appleFormCallback
);

// Apple Client Secret generator helper
router.get("/apple/client-secret", getAppleClientSecret);

// 5. Token Refresh (Rotation + Theft Detection)
router.post("/refresh", refresh);

// 6. Logout Current Session
router.post("/logout", logout);

// 7. Logout All Sessions (Protected)
router.post("/logout-all", authMiddleware, logoutAll);

module.exports = router;
