const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "poster-code-dev-secret-change-me";

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Access token is required.",
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired access token.",
    });
  }
}

module.exports = {
  requireAuth,
  JWT_SECRET,
};
