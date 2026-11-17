const config = require("../config/env");

const REFRESH_COOKIE_NAME = "refreshToken";

function getRefreshCookieOptions() {
  const isProduction = config.nodeEnv === "production";
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    domain: config.cookieDomain,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: "/auth",
  };
}

function setRefreshTokenCookie(res, token) {
  res.cookie(REFRESH_COOKIE_NAME, token, getRefreshCookieOptions());
}

function clearRefreshTokenCookie(res) {
  const options = getRefreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: options.httpOnly,
    secure: options.secure,
    sameSite: options.sameSite,
    domain: options.domain,
    path: options.path,
  });
}

module.exports = {
  REFRESH_COOKIE_NAME,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
};
