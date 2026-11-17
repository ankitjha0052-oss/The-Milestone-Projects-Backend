const { OAuth2Client } = require("google-auth-library");
const config = require("../config/env");

const client = new OAuth2Client(config.googleClientId);

/**
 * Verify Google ID Token with google-auth-library
 */
async function verifyGoogleIdToken(idToken) {
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: config.googleClientId,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email) {
      const err = new Error("Invalid Google token payload");
      err.code = "INVALID_GOOGLE_TOKEN";
      err.statusCode = 401;
      throw err;
    }

    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: Boolean(payload.email_verified),
      name: payload.name,
      givenName: payload.given_name,
      familyName: payload.family_name,
      picture: payload.picture,
      locale: payload.locale,
    };
  } catch (error) {
    if (error.statusCode) throw error;
    const err = new Error(`Google token verification failed: ${error.message}`);
    err.code = "INVALID_GOOGLE_TOKEN";
    err.statusCode = 401;
    throw err;
  }
}

module.exports = {
  verifyGoogleIdToken,
};
