const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const pool = require("./pool");
const authMiddleware = require("./authMiddleware");
const { formatUserResponse } = require("./authHelper");

const router = express.Router();

// Ensure avatar uploads directory exists
const avatarUploadDir = path.join(__dirname, "../public/uploads/avatars");
if (!fs.existsSync(avatarUploadDir)) {
  fs.mkdirSync(avatarUploadDir, { recursive: true });
}

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, avatarUploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeName = `avatar-${req.user ? req.user.id : Date.now()}-${Date.now()}${ext}`;
    cb(null, safeName);
  },
});

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const okExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext);
    const okMime = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
    if (okExt && okMime) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, WEBP, GIF images allowed'));
    }
  },
});

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

// PATCH /user/me -> Update profile (name, phone, birthday, location, headline, bio, picture, etc.)
router.patch("/me", authMiddleware, async (req, res, next) => {
  try {
    const {
      name,
      givenName,
      familyName,
      phone,
      birthday,
      gender,
      country,
      timezone,
      location,
      headline,
      bio,
      picture,
      locale,
    } = req.body;

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

    if (givenName !== undefined) {
      updates.push("given_name = ?");
      updateVals.push(givenName ? String(givenName).trim() : null);
    }

    if (familyName !== undefined) {
      updates.push("family_name = ?");
      updateVals.push(familyName ? String(familyName).trim() : null);
    }

    if (phone !== undefined) {
      if (phone && !/^\+?[0-9\s\-()]{7,25}$/.test(String(phone).trim())) {
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

    if (location !== undefined) {
      updates.push("location = ?");
      updateVals.push(location ? String(location).trim().slice(0, 255) : null);
    }

    if (headline !== undefined) {
      updates.push("headline = ?");
      updateVals.push(headline ? String(headline).trim().slice(0, 255) : null);
    }

    if (bio !== undefined) {
      updates.push("bio = ?");
      updateVals.push(bio ? String(bio).trim() : null);
    }

    if (picture !== undefined) {
      // Supports both HTTP/HTTPS web URLs and Base64 Data URIs
      if (picture && !/^(https?:\/\/|data:image\/[a-zA-Z+]+;base64,).+/i.test(picture)) {
        return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Picture must be a valid HTTP/HTTPS URL or Base64 Data URI" } });
      }
      updates.push("picture = ?");
      updateVals.push(picture || null);
    }

    if (gender !== undefined) { updates.push("gender = ?"); updateVals.push(gender || null); }
    if (country !== undefined) { updates.push("country = ?"); updateVals.push(country || null); }
    if (timezone !== undefined) { updates.push("timezone = ?"); updateVals.push(timezone || null); }
    if (locale !== undefined) { updates.push("locale = ?"); updateVals.push(locale || null); }

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
      status: true,
      message: "Profile updated successfully",
      user: {
        ...formatUserResponse(updatedUser[0]),
        identities,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /user/avatar -> Multipart Form-Data upload for compressed avatar image
router.post("/avatar", authMiddleware, uploadAvatar.single("file"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Avatar image file is required ('file' field)" } });
    }

    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    await pool.query("UPDATE users SET picture = ? WHERE id = ?", [avatarUrl, req.user.id]);

    const [updatedUser] = await pool.query("SELECT * FROM users WHERE id = ?", [req.user.id]);

    res.json({
      status: true,
      message: "Avatar uploaded successfully",
      picture: avatarUrl,
      user: formatUserResponse(updatedUser[0]),
    });
  } catch (err) {
    next(err);
  }
});

// GET /user (legacy test endpoint)
router.get("/", function (req, res, next) {
  res.send("respond with a resource");
});

module.exports = router;
