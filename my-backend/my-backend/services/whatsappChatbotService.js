const { sendWhatsAppText } = require("./whatsappService");
const {
  handleGcrGraphixGreeting,
  isGcrGraphixGreeting,
  findUserByMobile,
  createLoginLinkForUser,
  toTenDigitMobile,
} = require("../utils/portalAuth");
const { sendWhatsAppLoginLink } = require("./whatsappTemplateService");
const { startCaptionFlow } = require("./whatsappCaptionService");

function normalizeChatText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMenuIntent(text) {
  const normalized = normalizeChatText(text);
  if (!normalized) {
    return false;
  }

  // Do NOT treat "Hi GCR Graphix" as menu — that greeting opens login/register.
  if (isGcrGraphixGreeting(text)) {
    return false;
  }

  const triggers = [
    "hi",
    "hello",
    "hey",
    "hii",
    "hiii",
    "namaste",
    "namaskar",
    "menu",
    "start",
    "help",
  ];

  return triggers.some(
    (trigger) =>
      normalized === trigger ||
      normalized.startsWith(`${trigger} `) ||
      normalized.endsWith(` ${trigger}`),
  );
}

function detectMenuChoice(text) {
  const normalized = normalizeChatText(text);
  if (!normalized) {
    return null;
  }

  if (
    ["1", "register", "login", "account", "sign up", "signup", "sign in"].includes(
      normalized,
    ) ||
    normalized.includes("register") ||
    normalized.includes("login") ||
    normalized.includes("account")
  ) {
    return "account";
  }

  if (
    ["2", "facebook", "fb", "instagram", "ig", "connect"].includes(normalized) ||
    normalized.includes("facebook") ||
    normalized.includes("instagram") ||
    normalized.includes("connect")
  ) {
    return "social";
  }

  if (
    ["3", "poster", "posters", "how", "kaise"].includes(normalized) ||
    normalized.includes("poster") ||
    normalized.includes("how it works") ||
    normalized.includes("kaise")
  ) {
    return "poster_help";
  }

  if (
    ["4", "support", "contact", "help desk", "call"].includes(normalized) ||
    normalized.includes("support") ||
    normalized.includes("contact")
  ) {
    return "support";
  }

  if (
    ["5", "services", "price", "pricing", "about", "service"].includes(normalized) ||
    normalized.includes("service") ||
    normalized.includes("price") ||
    normalized.includes("about")
  ) {
    return "services";
  }

  if (
    ["6", "caption", "captions", "ai caption", "shayari"].includes(normalized) ||
    normalized.includes("caption") ||
    normalized.includes("shayari")
  ) {
    return "caption";
  }

  if (normalized === "menu" || normalized === "start") {
    return "menu";
  }

  return null;
}

function getSupportContact() {
  return (
    String(process.env.WHATSAPP_SUPPORT_CONTACT || "").trim() ||
    String(process.env.SUPPORT_WHATSAPP || "").trim() ||
    "GCR Graphix support"
  );
}

function buildMainMenuMessage(name) {
  const greeting = name ? `Hi ${name}!` : "Welcome to GCR Graphix!";
  return (
    `${greeting}\n\n` +
    `Main menu — reply with a number:\n\n` +
    `1. Register / Login\n` +
    `2. Connect Facebook / Instagram\n` +
    `3. How posters work\n` +
    `4. Support\n` +
    `5. Our services\n` +
    `6. AI caption (Hindi / English / Shayari)\n\n` +
    `Type *menu* anytime to see this again.`
  );
}

function buildPosterHelpMessage() {
  return (
    `How GCR Graphix posters work:\n\n` +
    `1. Register / login from WhatsApp (option 1)\n` +
    `2. Complete your profile (name, photo, details)\n` +
    `3. Connect Facebook Page (optional) for auto post\n` +
    `4. Admin generates your event poster\n` +
    `5. You receive the poster here on WhatsApp\n` +
    `6. Optional: reply *6* for AI captions, then tap *Approve*\n\n` +
    `Type *menu* for more options.`
  );
}

function buildServicesMessage() {
  return (
    `GCR Graphix services:\n\n` +
    `• Event & campaign posters\n` +
    `• WhatsApp poster delivery\n` +
    `• Facebook / Instagram posting\n` +
    `• AI captions (Hindi / English / leader shayari)\n` +
    `• Bulk poster generation for teams\n\n` +
    `For custom work, reply *4* (Support).\n` +
    `Type *menu* to go back.`
  );
}

function buildSupportMessage() {
  const contact = getSupportContact();
  return (
    `Need help?\n\n` +
    `Contact: ${contact}\n\n` +
    `You can also reply here with your question.\n` +
    `Type *menu* for main options.`
  );
}

async function sendMainMenu({ toMobile, name }) {
  return sendWhatsAppText({
    toMobile,
    body: buildMainMenuMessage(name),
  });
}

async function handleAccountOption(fromWhatsAppNumber) {
  return handleGcrGraphixGreeting(fromWhatsAppNumber);
}

async function handleSocialOption(fromWhatsAppNumber) {
  const mobileNumber = toTenDigitMobile(fromWhatsAppNumber);
  const user = await findUserByMobile(fromWhatsAppNumber);

  if (!user) {
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body:
        `To connect Facebook / Instagram, register first.\n\n` +
        `Sending your registration link…`,
    });
    return handleGcrGraphixGreeting(fromWhatsAppNumber);
  }

  const { token, loginUrl } = await createLoginLinkForUser(user);
  await sendWhatsAppText({
    toMobile: fromWhatsAppNumber,
    body:
      `Hi ${user.name || "there"},\n\n` +
      `Open your account and tap *Connect Facebook*.\n` +
      `Use Chrome/Safari if the link opens inside WhatsApp.`,
  });
  await sendWhatsAppLoginLink({
    toMobile: mobileNumber,
    name: user.name,
    token,
    loginUrl,
  });

  return { handled: true, type: "social_login_link" };
}

/**
 * Handle inbound WhatsApp chatbot messages (menu 1–6).
 * Caption flow is delegated to whatsappCaptionService.
 * Returns { handled: true } when a reply was sent.
 */
async function handleWhatsAppChatbot({ fromWhatsAppNumber, bodyText }) {
  const mobileNumber = toTenDigitMobile(fromWhatsAppNumber);
  if (!/^\d{10}$/.test(mobileNumber)) {
    return { handled: false, reason: "invalid_mobile" };
  }

  // Exact portal greeting always opens login / register (same as before chatbot).
  if (isGcrGraphixGreeting(bodyText)) {
    await handleGcrGraphixGreeting(fromWhatsAppNumber);
    return { handled: true, type: "gcr_greeting" };
  }

  const choice = detectMenuChoice(bodyText);
  const wantsMenu = isMenuIntent(bodyText) || choice === "menu";

  if (!choice && !wantsMenu) {
    return { handled: false };
  }

  const user = await findUserByMobile(fromWhatsAppNumber);
  const name = user?.name || "";

  if (!choice || choice === "menu") {
    await sendMainMenu({ toMobile: fromWhatsAppNumber, name });
    return { handled: true, type: "menu" };
  }

  if (choice === "account") {
    await handleAccountOption(fromWhatsAppNumber);
    return { handled: true, type: "account" };
  }

  if (choice === "social") {
    await handleSocialOption(fromWhatsAppNumber);
    return { handled: true, type: "social" };
  }

  if (choice === "poster_help") {
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body: buildPosterHelpMessage(),
    });
    return { handled: true, type: "poster_help" };
  }

  if (choice === "support") {
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body: buildSupportMessage(),
    });
    return { handled: true, type: "support" };
  }

  if (choice === "services") {
    await sendWhatsAppText({
      toMobile: fromWhatsAppNumber,
      body: buildServicesMessage(),
    });
    return { handled: true, type: "services" };
  }

  if (choice === "caption") {
    return startCaptionFlow(fromWhatsAppNumber);
  }

  return { handled: false };
}

module.exports = {
  handleWhatsAppChatbot,
  isMenuIntent,
  detectMenuChoice,
  buildMainMenuMessage,
};
