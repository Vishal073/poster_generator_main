const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("./requireAuth");

function requireUserAuth(req, res, next) {
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

    if (decoded.role !== "user" || !decoded.userId) {
      return res.status(403).json({
        success: false,
        message: "User access token is required.",
      });
    }

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
  requireUserAuth,
};
