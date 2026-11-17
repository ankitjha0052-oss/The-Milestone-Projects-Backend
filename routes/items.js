const express = require("express");
const pool = require("./pool");
const authMiddleware = require("./authMiddleware");

const router = express.Router();

router.use(authMiddleware);

// GET /items?limit=20&cursor=<id> -> Cursor-based pagination
router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const cursor = req.query.cursor;

    let query = "SELECT * FROM items WHERE user_id = ?";
    let params = [req.user.id];

    if (cursor) {
      const [cursorItem] = await pool.query(
        "SELECT created_at, id FROM items WHERE id = ? AND user_id = ?",
        [cursor, req.user.id]
      );

      if (cursorItem.length > 0) {
        query += " AND (created_at < ? OR (created_at = ? AND id < ?))";
        params.push(cursorItem[0].created_at, cursorItem[0].created_at, cursorItem[0].id);
      }
    }

    query += " ORDER BY created_at DESC, id DESC LIMIT ?";
    params.push(limit + 1);

    const [items] = await pool.query(query, params);

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    res.json({ data, nextCursor, hasMore });
  } catch (err) {
    next(err);
  }
});

// POST /items -> Create item
router.post("/", async (req, res, next) => {
  try {
    const { title, description } = req.body;
    const crypto = require("crypto");
    const id = crypto.randomUUID();

    await pool.query(
      "INSERT INTO items (id, user_id, title, description) VALUES (?, ?, ?, ?)",
      [id, req.user.id, title, description || null]
    );

    const [created] = await pool.query("SELECT * FROM items WHERE id = ?", [id]);
    res.status(201).json({ item: created[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
