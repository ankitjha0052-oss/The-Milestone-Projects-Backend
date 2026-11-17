const { Item } = require("../models");
const { Op } = require("sequelize");

/**
 * GET /items?limit=20&cursor=<id>
 * Cursor-based pagination sorted by createdAt desc then id desc
 */
async function getItems(req, res, next) {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const cursor = req.query.cursor;

    let whereClause = {
      userId: req.user.id,
    };

    if (cursor) {
      const cursorItem = await Item.findOne({
        where: { id: cursor, userId: req.user.id },
      });

      if (cursorItem) {
        whereClause = {
          userId: req.user.id,
          [Op.or]: [
            {
              createdAt: {
                [Op.lt]: cursorItem.createdAt,
              },
            },
            {
              createdAt: cursorItem.createdAt,
              id: {
                [Op.lt]: cursorItem.id,
              },
            },
          ],
        };
      }
    }

    const items = await Item.findAll({
      where: whereClause,
      limit: limit + 1,
      order: [
        ["createdAt", "DESC"],
        ["id", "DESC"],
      ],
    });

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    res.status(200).json({
      data,
      nextCursor,
      hasMore,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /items (Create helper)
 */
async function createItem(req, res, next) {
  try {
    const { title, description } = req.body;
    const item = await Item.create({
      userId: req.user.id,
      title,
      description,
    });

    res.status(201).json({ item });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getItems,
  createItem,
};
