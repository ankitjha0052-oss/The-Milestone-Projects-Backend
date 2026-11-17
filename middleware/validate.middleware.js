/**
 * Validate express req (body, query, params) against a Zod schema
 */
function validateRequest(schema) {
  return async (req, res, next) => {
    try {
      if (schema.body) {
        req.body = await schema.body.parseAsync(req.body);
      }
      if (schema.query) {
        req.query = await schema.query.parseAsync(req.query);
      }
      if (schema.params) {
        req.params = await schema.params.parseAsync(req.params);
      }
      next();
    } catch (error) {
      if (error.errors) {
        const details = error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        }));
        return res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request payload",
            details,
          },
        });
      }
      next(error);
    }
  };
}

module.exports = validateRequest;
