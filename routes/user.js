const express = require("express");
const pool = require("./pool");
const authMiddleware = require("./authMiddleware");
const { formatUserResponse } = require("./authHelper");

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
        ...formatUserResponse(req.user),
        identities,
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /user/me -> Update profile (phone, birthday, gender, country, timezone, onboarding)
router.patch("/me", authMiddleware, async (req, res, next) => {
  try {
    const { name, givenName, familyName, phone, birthday, gender, country, timezone, picture, locale } = req.body;
    const updates = [];
    const updateVals = [];

    // Validations
    if (name !== undefined) {
      if (typeof name !== "string" || name.length > 255) {
        return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Name must be a valid string (max 255 chars)" } });
      }
      updates.push("name = ?");
      updateVals.push(name.trim());
    }

    if (givenName !== undefined) { updates.push("given_name = ?"); updateVals.push(givenName ? String(givenName).trim() : null); }
    if (familyName !== undefined) { updates.push("family_name = ?"); updateVals.push(familyName ? String(familyName).trim() : null); }

    if (phone !== undefined) {
      if (phone && !/^\+?[0-9\s\-()]{7,20}$/.test(String(phone).trim())) {
        return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid phone number format" } });
      }
      updates.push("phone = ?");
      updateVals.push(phone ? String(phone).trim() : null);
    }

    if (birthday !== undefined) {
      if (birthday && isNaN(Date.parse(birthday))) {
        return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid birthday date format (use YYYY-MM-DD)" } });
      }
      updates.push("birthday = ?");
      updateVals.push(birthday || null);
    }

    if (picture !== undefined) {
      if (picture && !/^https?:\/\/.+/i.test(picture)) {
        return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Picture must be a valid URL" } });
      }
      updates.push("picture = ?");
      updateVals.push(picture || null);
    }

    if (gender !== undefined) { updates.push("gender = ?"); updateVals.push(gender || null); }
    if (country !== undefined) { updates.push("country = ?"); updateVals.push(country || null); }
    if (timezone !== undefined) { updates.push("timezone = ?"); updateVals.push(timezone || null); }
    if (locale !== undefined) { updates.push("locale = ?"); updateVals.push(locale || null); }

    // If candidate has completed basic profile fields, mark profile_completed = true
    updates.push("profile_completed = TRUE");

    if (updates.length > 0) {
      updateVals.push(req.user.id);
      await pool.query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, updateVals);
    }

    const [updatedUser] = await pool.query("SELECT * FROM users WHERE id = ?", [req.user.id]);
    const [identities] = await pool.query(
      "SELECT provider, provider_user_id, email, is_private_email, created_at FROM auth_identities WHERE user_id = ?",
      [req.user.id]
    );

    res.json({
      user: {
        ...formatUserResponse(updatedUser[0]),
        identities,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /user (legacy test endpoint)
router.get("/", function(req, res, next) {
  res.send("respond with a resource");
});

module.exports = router;
