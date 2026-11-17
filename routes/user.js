const express = require("express");
const pool = require("./pool");
const authMiddleware = require("./authMiddleware");

const router = express.Router();

// GET /user/me -> Current User Profile + Linked Identities
router.get("/me", authMiddleware, async (req, res, next) => {
  try {
    const [identities] = await pool.query(
      "SELECT provider, provider_user_id, email, is_private_email, created_at FROM auth_identities WHERE user_id = ?",
      [req.user.id]
    );

    res.json({
      user: {
        ...req.user,
        identities,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /user/me -> Update profile (phone, birthday, name, picture, etc.)
router.patch("/me", authMiddleware, async (req, res, next) => {
  try {
    const { name, phone, birthday, picture, locale } = req.body;
    const updates = [];
    const updateVals = [];

    if (name !== undefined) { updates.push("name = ?"); updateVals.push(name); }
    if (phone !== undefined) { updates.push("phone = ?"); updateVals.push(phone); }
    if (birthday !== undefined) { updates.push("birthday = ?"); updateVals.push(birthday); }
    if (picture !== undefined) { updates.push("picture = ?"); updateVals.push(picture); }
    if (locale !== undefined) { updates.push("locale = ?"); updateVals.push(locale); }

    if (updates.length > 0) {
      updateVals.push(req.user.id);
      await pool.query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, updateVals);
    }

    const [updatedUser] = await pool.query(
      "SELECT id, name, email, email_verified, picture, locale, phone, birthday FROM users WHERE id = ?",
      [req.user.id]
    );

    res.json({ user: updatedUser[0] });
  } catch (err) {
    next(err);
  }
});

// GET /user (legacy test endpoint)
router.get("/", function(req, res, next) {
  res.send("respond with a resource");
});

module.exports = router;
