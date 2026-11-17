/**
 * Centralized error handler returning consistent format:
 * { error: { code, message } }
 */
function errorHandler(err, _req, res, _next) {
  // Never log tokens or secrets
  const statusCode = err.statusCode || 500;
  const code = err.code || "INTERNAL_SERVER_ERROR";
  const message = err.message || "An unexpected error occurred";

  if (statusCode === 500) {
    console.error("Server Error:", err.message);
  }

  res.status(statusCode).json({
    error: {
      code,
      message,
    },
  });
}

module.exports = errorHandler;
