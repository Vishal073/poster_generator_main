const nodemailer = require("nodemailer");

function createTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      "SMTP configuration is missing. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS."
    );
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: SMTP_SECURE === "true",
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

async function sendPosterEmail({ toEmail, posterBuffer, fileName, fromEmail }) {
  if (!toEmail || typeof toEmail !== "string") {
    throw new Error("Recipient email is required.");
  }
  if (!posterBuffer) {
    throw new Error("Poster buffer is required.");
  }

  const transporter = createTransporter();
  const sender = fromEmail || process.env.SMTP_FROM || process.env.SMTP_USER;

  return transporter.sendMail({
    from: sender,
    to: toEmail,
    subject: "Your Personalized Poster",
    text: "Please find your personalized poster attached.",
    attachments: [
      {
        filename: fileName || "personalized-poster.png",
        content: posterBuffer,
        contentType: "image/png",
      },
    ],
  });
}

module.exports = {
  sendPosterEmail,
};
