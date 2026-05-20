const mongoose = require("mongoose");

function requireDb(req, res, next) {
  if (mongoose.connection.readyState === 1) {
    return next();
  }

  return res.status(503).json({
    success: false,
    message: "Database is not connected. Check MONGO_URI on Render and Atlas Network Access (0.0.0.0/0).",
    dbState: mongoose.connection.readyState,
  });
}

module.exports = {
  requireDb,
};
