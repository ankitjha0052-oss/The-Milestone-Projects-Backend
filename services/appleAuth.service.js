const jwksClient = require("jwks-rsa");
const jwt = require("jsonwebtoken");
const { SignJWT, importPKCS8 } = require("jose");
const config = require("../config/env");

const APPLE_JWKS_URI = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";

const client = jwksClient({
  jwksUri: APPLE_JWKS_URI,
  cache: true,
  cacheMaxAge: 24 * 60 * 60 * 1000,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

function getKey(header, callback) {
  if (!header.kid) {
    return callback(new Error("No kid in Apple token header"));
  }
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const signingKey = key ? key.getPublicKey() : null;
    callback(null, signingKey);
  });
}

/**
 * Verify Apple ID Token signature against Apple's live JWKS
 */
function verifyAppleIdToken(idToken) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      idToken,
      getKey,
      {
        issuer: APPLE_ISSUER,
        audience: config.appleClientId,
        algorithms: ["RS256"],
      },
      (err, decoded) => {
        if (err) {
          const error = new Error(`Apple token verification failed: ${err.message}`);
          error.code = "INVALID_APPLE_TOKEN";
          error.statusCode = 401;
          return reject(error);
        }

        if (!decoded || !decoded.sub) {
          const error = new Error("Invalid Apple token payload");
          error.code = "INVALID_APPLE_TOKEN";
          error.statusCode = 401;
          return reject(error);
        }

        const emailVerified =
          decoded.email_verified === true || decoded.email_verified === "true";
        const isPrivateEmail =
          decoded.is_private_email === true || decoded.is_private_email === "true";

        resolve({
          sub: decoded.sub,
          email: decoded.email,
          emailVerified,
          isPrivateEmail,
        });
      }
    );
  });
}

/**
 * Generate Apple client_secret ES256 JWT
 */
async function generateAppleClientSecret() {
  if (!config.appleTeamId || !config.appleKeyId || !config.applePrivateKey) {
    const err = new Error(
      "Apple credentials missing: APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY required"
    );
    err.code = "MISSING_APPLE_CREDENTIALS";
    err.statusCode = 400;
    throw err;
  }

  let privateKeyPem = config.applePrivateKey;
  if (!privateKeyPem.includes("\n") && privateKeyPem.includes("\\n")) {
    privateKeyPem = privateKeyPem.replace(/\\n/g, "\n");
  }

  const privateKey = await importPKCS8(privateKeyPem, "ES256");
  const now = Math.floor(Date.now() / 1000);
  const expirationTime = now + 180 * 24 * 60 * 60; // 180 days (max 6 months)

  const secretJwt = await new SignJWT({})
    .setProtectedHeader({
      alg: "ES256",
      kid: config.appleKeyId,
    })
    .setIssuer(config.appleTeamId)
    .setIssuedAt(now)
    .setExpirationTime(expirationTime)
    .setAudience("https://appleid.apple.com")
    .setSubject(config.appleClientId)
    .sign(privateKey);

  return secretJwt;
}

module.exports = {
  verifyAppleIdToken,
  generateAppleClientSecret,
};
