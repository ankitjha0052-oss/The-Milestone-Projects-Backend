require("dotenv").config();

const config = {
  port: process.env.PORT || 8602,
  nodeEnv: process.env.NODE_ENV || "development",
  accessTokenSecret:
    process.env.ACCESS_TOKEN_SECRET || "default_super_secret_access_token_key_12345",
  googleClientId:
    process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  appleClientId: process.env.APPLE_CLIENT_ID || "com.themilestoneprojects.web.auth",
  appleTeamId: process.env.APPLE_TEAM_ID || "",
  appleKeyId: process.env.APPLE_KEY_ID || "",
  applePrivateKey: process.env.APPLE_PRIVATE_KEY || "",
  allowedOrigins: (
    process.env.ALLOWED_ORIGINS ||
    "http://localhost:5173,https://themilestoneprojects.co.in"
  )
    .split(",")
    .map((o) => o.trim()),
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
};

module.exports = config;
