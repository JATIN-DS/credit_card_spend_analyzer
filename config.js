// Configuration + localStorage persistence.
// Everything is stored locally in the browser. Nothing is sent anywhere
// except the normal authenticated calls to Google's Gmail API.

const STORAGE_KEYS = {
  clientId: "csa_client_id",
  cards: "csa_cards_v2", // saved card library
  active: "csa_active_cards", // ids selected on the homepage
  lookback: "csa_lookback_months",
  statements: "csa_statements_count", // global: statements to fetch PER card
  token: "csa_token",
};

// How far back to search Gmail, in months. Acts as a hard cap on how old a
// fetched statement can be, regardless of the per-card bill count.
const DEFAULT_LOOKBACK_MONTHS = 6;

// Default saved-card library. Each card is matched in Gmail by BOTH the sender
// address and a substring of the email subject, so multiple variants from the
// same issuer (e.g. ICICI) are told apart. `count` = number of recent bills.
const DEFAULT_CARDS = [
  {
    id: "amazon-icici",
    label: "Amazon Pay ICICI",
    bank: "ICICI",
    sender: "credit_cards@icici.bank.in",
    subject: "Amazon Pay ICICI Bank Credit Card Statement",
    password: "",
    last4: "",
    count: 1,
  },
  {
    id: "icici",
    label: "ICICI Bank Card",
    bank: "ICICI",
    sender: "credit_cards@icici.bank.in",
    subject: "ICICI Bank Credit Card Statement for the period",
    password: "",
    last4: "",
    count: 1,
  },
  {
    id: "flipkart-axis",
    label: "Flipkart Axis",
    bank: "AXIS",
    sender: "cc.statements@axis.bank.in",
    subject: "Flipkart Axis Bank Credit Card Statement ending",
    password: "",
    last4: "",
    count: 1,
  },
  {
    id: "swiggy-hdfc",
    label: "Swiggy HDFC",
    bank: "HDFC",
    sender: "Emailstatements.cards@hdfcbank.bank.in",
    subject: "Your HDFC Bank - Swiggy HDFC Bank Credit Card Statement",
    password: "",
    last4: "",
    count: 1,
  },
];

const SUPPORTED_BANKS = ["HDFC", "AXIS", "ICICI", "SBI", "AMEX"];
const MAX_BILLS_PER_CARD = 18;
// Upper bound for the Gmail look-back window (months).
const MAX_LOOKBACK_MONTHS = 20;
// How many recent statements to fetch per card. This is a single global value
// applied uniformly to every card (not per-card), chosen right before fetching.
const DEFAULT_STATEMENTS_COUNT = 1;

function genId() {
  return "card-" + Math.random().toString(36).slice(2, 9);
}

function getClientId() {
  return localStorage.getItem(STORAGE_KEYS.clientId) || "";
}

function setClientId(id) {
  localStorage.setItem(STORAGE_KEYS.clientId, id.trim());
}

function getCards() {
  const raw = localStorage.getItem(STORAGE_KEYS.cards);
  if (!raw) return structuredClone(DEFAULT_CARDS);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) {
      // ensure every card has an id (older saves / hand edits)
      return parsed.map((c) => ({ ...c, id: c.id || genId() }));
    }
  } catch (_) {
    /* fall through to defaults */
  }
  return structuredClone(DEFAULT_CARDS);
}

function setCards(cards) {
  localStorage.setItem(STORAGE_KEYS.cards, JSON.stringify(cards));
}

function getActiveCardIds() {
  const raw = localStorage.getItem(STORAGE_KEYS.active);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {
    /* ignore */
  }
  return [];
}

function setActiveCardIds(ids) {
  localStorage.setItem(STORAGE_KEYS.active, JSON.stringify(ids));
}

function getLookbackMonths() {
  const raw = localStorage.getItem(STORAGE_KEYS.lookback);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LOOKBACK_MONTHS) : DEFAULT_LOOKBACK_MONTHS;
}

function setLookbackMonths(months) {
  const n = parseInt(months, 10);
  const safe = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LOOKBACK_MONTHS) : DEFAULT_LOOKBACK_MONTHS;
  localStorage.setItem(STORAGE_KEYS.lookback, String(safe));
}

// Global statements-to-fetch-per-card count (1..MAX_BILLS_PER_CARD).
function getStatementsCount() {
  const n = parseInt(localStorage.getItem(STORAGE_KEYS.statements), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_STATEMENTS_COUNT;
  return Math.min(n, MAX_BILLS_PER_CARD);
}
function setStatementsCount(count) {
  const n = parseInt(count, 10);
  const safe = Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_BILLS_PER_CARD) : DEFAULT_STATEMENTS_COUNT;
  localStorage.setItem(STORAGE_KEYS.statements, String(safe));
}

// --- Gmail access token persistence -------------------------------------
// Access tokens are short-lived (~1 hour). We store the token + its expiry so
// page reloads within that window don't require reconnecting. A 60s safety
// buffer avoids using a token that's about to expire mid-request.
function setStoredToken(accessToken, expiresInSec) {
  const expiresAt = Date.now() + (Number(expiresInSec) || 3600) * 1000;
  localStorage.setItem(
    STORAGE_KEYS.token,
    JSON.stringify({ accessToken, expiresAt })
  );
}

function getStoredToken() {
  const raw = localStorage.getItem(STORAGE_KEYS.token);
  if (!raw) return null;
  try {
    const { accessToken, expiresAt } = JSON.parse(raw);
    if (accessToken && expiresAt && Date.now() < expiresAt - 60000) {
      return accessToken;
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

function getStoredTokenExpiry() {
  const raw = localStorage.getItem(STORAGE_KEYS.token);
  if (!raw) return null;
  try {
    const { expiresAt } = JSON.parse(raw);
    return expiresAt || null;
  } catch (_) {
    return null;
  }
}

function clearStoredToken() {
  localStorage.removeItem(STORAGE_KEYS.token);
}

// Theme persistence (dark | light).
function getTheme() {
  return localStorage.getItem("csa_theme") === "light" ? "light" : "dark";
}
function setTheme(theme) {
  localStorage.setItem("csa_theme", theme === "light" ? "light" : "dark");
}

export {
  STORAGE_KEYS,
  DEFAULT_CARDS,
  DEFAULT_LOOKBACK_MONTHS,
  SUPPORTED_BANKS,
  MAX_BILLS_PER_CARD,
  MAX_LOOKBACK_MONTHS,
  DEFAULT_STATEMENTS_COUNT,
  getStatementsCount,
  setStatementsCount,
  genId,
  getClientId,
  setClientId,
  getCards,
  setCards,
  getActiveCardIds,
  setActiveCardIds,
  getLookbackMonths,
  setLookbackMonths,
  setStoredToken,
  getStoredToken,
  getStoredTokenExpiry,
  clearStoredToken,
  getTheme,
  setTheme,
};
