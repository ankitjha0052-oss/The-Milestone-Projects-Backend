const { User, AuthIdentity } = require("../models");

/**
 * GET /me -> current user profile with identities
 */
async function getMe(req, res, next) {
  try {
    const userProfile = await User.findByPk(req.user.id, {
      include: [
        {
          model: AuthIdentity,
          as: "identities",
          attributes: [
            "provider",
            "providerUserId",
            "email",
            "isPrivateEmail",
            "createdAt",
          ],
        },
      ],
    });

    res.status(200).json({
      user: userProfile,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PATCH /me -> update profile (phone, birthday, etc.)
 */
async function updateMe(req, res, next) {
  try {
    const { name, phone, birthday, picture, locale } = req.body;

    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: "User not found",
        },
      });
    }

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (birthday !== undefined) updates.birthday = birthday;
    if (picture !== undefined) updates.picture = picture;
    if (locale !== undefined) updates.locale = locale;

    await user.update(updates);

    res.status(200).json({
      user,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getMe,
  updateMe,
};
