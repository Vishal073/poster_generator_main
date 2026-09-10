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
    `5. Our services\n\n` +
    `AI Caption: type *Hi GCR Graphix*, then send your event text.\n` +
    `Type *menu* anytime to see this again.`
  );
}

function buildPosterHelpMessage() {
  return (
    `How GCR Graphix posters work:\n\n` +
    `1. Register / login: *Hi GCR Graphix*\n` +
    `2. Complete your profile\n` +
    `3. Connect Facebook Page (optional)\n` +
    `4. Admin sends your poster here\n` +
    `5. Tap *Approve* to post on Facebook / Instagram\n\n` +
    `AI Caption: *Hi GCR Graphix* ke baad event text bhejo.\n` +
    `Type *menu* for more options.`
  );
}

function buildServicesMessage() {
  return (
    `GCR Graphix services:\n\n` +
    `• Event & campaign posters\n` +
    `• WhatsApp poster delivery\n` +
    `• Facebook / Instagram posting\n` +
    `• AI Hindi captions (shayari ya normal)\n` +
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
 * Menu + Hi GCR Graphix (login + caption mode).
 */
async function handleWhatsAppChatbot({ fromWhatsAppNumber, bodyText }) {
  const mobileNumber = toTenDigitMobile(fromWhatsAppNumber);
  if (!/^\d{10}$/.test(mobileNumber)) {
    return { handled: false, reason: "invalid_mobile" };
  }

  // Hi GCR Graphix → login/register link, then caption mode.
  if (isGcrGraphixGreeting(bodyText)) {
    await handleGcrGraphixGreeting(fromWhatsAppNumber);
    await startCaptionFlow(fromWhatsAppNumber);
    return { handled: true, type: "gcr_greeting_caption" };
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

  return { handled: false };
}

module.exports = {
  handleWhatsAppChatbot,
  isMenuIntent,
  detectMenuChoice,
  buildMainMenuMessage,
};
