const { z } = require("zod");

const googleAuthSchema = z.object({
  idToken: z.string().min(1, "Google idToken is required"),
});

const appleAuthSchema = z.object({
  idToken: z.string().min(1, "Apple idToken is required"),
  user: z
    .object({
      name: z
        .object({
          firstName: z.string().optional(),
          lastName: z.string().optional(),
        })
        .optional(),
      email: z.string().email().optional(),
    })
    .optional(),
});

const appleCallbackSchema = z.object({
  id_token: z.string().min(1, "Apple id_token is required"),
  code: z.string().optional(),
  state: z.string().optional(),
  user: z.string().optional(),
});

const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  birthday: z.string().optional(),
  picture: z.string().url().optional(),
  locale: z.string().optional(),
});

const getItemsSchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 20))
    .refine((val) => !isNaN(val) && val >= 1 && val <= 100, {
      message: "limit must be between 1 and 100",
    }),
  cursor: z.string().optional(),
});

module.exports = {
  googleAuthSchema,
  appleAuthSchema,
  appleCallbackSchema,
  updateProfileSchema,
  getItemsSchema,
};
