const { encryptToken, decryptToken, isEncryptedToken } = require("./facebookTokenCrypto");

function decryptPageTokenFields(page) {
  if (!page || typeof page !== "object") {
    return page;
  }

  if (typeof page.pageAccessToken === "string" && page.pageAccessToken) {
    page.pageAccessToken = decryptToken(page.pageAccessToken);
  }

  return page;
}

function encryptPageTokenFields(page) {
  if (!page || typeof page !== "object") {
    return page;
  }

  if (typeof page.pageAccessToken === "string" && page.pageAccessToken) {
    page.pageAccessToken = encryptToken(page.pageAccessToken);
  }

  return page;
}

function hydrateConnectionTokens(connection) {
  if (!connection) {
    return connection;
  }

  const plain =
    typeof connection.toObject === "function"
      ? connection.toObject({ depopulate: true })
      : { ...connection };

  if (typeof plain.userAccessToken === "string" && plain.userAccessToken) {
    plain.userAccessToken = decryptToken(plain.userAccessToken);
  }

  if (Array.isArray(plain.pages)) {
    plain.pages = plain.pages.map((page) =>
      decryptPageTokenFields({ ...page }),
    );
  }

  if (plain.selectedPage) {
    plain.selectedPage = decryptPageTokenFields({ ...plain.selectedPage });
  }

  return plain;
}

function sealConnectionTokens(connection) {
  if (!connection || typeof connection !== "object") {
    return connection;
  }

  const sealed = { ...connection };

  if (typeof sealed.userAccessToken === "string" && sealed.userAccessToken) {
    sealed.userAccessToken = encryptToken(sealed.userAccessToken);
  }

  if (Array.isArray(sealed.pages)) {
    sealed.pages = sealed.pages.map((page) =>
      encryptPageTokenFields({ ...page }),
    );
  }

  if (sealed.selectedPage) {
    sealed.selectedPage = encryptPageTokenFields({ ...sealed.selectedPage });
  }

  return sealed;
}

function sealPlainTokensBeforeSave(doc) {
  if (!doc) {
    return;
  }

  if (typeof doc.userAccessToken === "string" && doc.userAccessToken) {
    if (!isEncryptedToken(doc.userAccessToken)) {
      doc.userAccessToken = encryptToken(doc.userAccessToken);
    }
  }

  if (Array.isArray(doc.pages)) {
    for (const page of doc.pages) {
      encryptPageTokenFields(page);
    }
  }

  if (doc.selectedPage) {
    encryptPageTokenFields(doc.selectedPage);
  }
}

function decryptLoadedConnectionDoc(doc) {
  if (!doc) {
    return;
  }

  if (typeof doc.userAccessToken === "string" && doc.userAccessToken) {
    doc.userAccessToken = decryptToken(doc.userAccessToken);
  }

  if (Array.isArray(doc.pages)) {
    for (const page of doc.pages) {
      decryptPageTokenFields(page);
    }
  }

  if (doc.selectedPage) {
    decryptPageTokenFields(doc.selectedPage);
  }
}

module.exports = {
  hydrateConnectionTokens,
  sealConnectionTokens,
  sealPlainTokensBeforeSave,
  decryptLoadedConnectionDoc,
};
