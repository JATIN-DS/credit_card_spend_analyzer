// Main orchestration: theme + navigation, OAuth (Google Identity Services),
// Gmail fetch, Pyodide PDF processing, and the dashboard / grouped views.

import {
  SUPPORTED_BANKS,
  MAX_BILLS_PER_CARD,
  genId,
  getClientId,
  setClientId,
  getCards,
  setCards,
  getActiveCardIds,
  setActiveCardIds,
  getLookbackMonths,
  setLookbackMonths,
  getStatementsCount,
  setStatementsCount,
  setStoredToken,
  getStoredToken,
  getStoredTokenExpiry,
  clearStoredToken,
  getTheme,
  setTheme,
} from "./config.js";
import {
  renderDashboards,
  friendlyMerchant,
  prettyCategory,
  inr,
} from "./charts.js";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

const state = {
  pyodide: null,
  pyReady: false,
  pyPromise: null,
  fetching: false,
  tokenClient: null,
  accessToken: null,
  tokenResolve: null,
  tokenReject: null,
  cardData: {}, // id -> { transactions, summaries }
  cardStatus: {}, // id -> status text
  expanded: new Set(), // open month|card panels in the breakdown
  allTxns: [],
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Logging + status
// ---------------------------------------------------------------------------
function log(msg, level = "info") {
  const el = $("log");
  const line = document.createElement("div");
  line.className = `log-line log-${level}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function setStatus(text, isHtml = false) {
  if (isHtml) $("status").innerHTML = text;
  else $("status").textContent = text;
}

// ---------------------------------------------------------------------------
// Theme + navigation
// ---------------------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelectorAll("#modeToggle .mode-toggle-option").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === theme);
  });
  setTheme(theme);
  // Re-render charts so their text/grid colors match the new theme.
  if (state.allTxns.length) { renderOverview(); renderMonthBreakdown(); }
}

function showView(view) {
  $("dashboardView").classList.toggle("hidden", view !== "dashboard");
  $("settingsView").classList.toggle("hidden", view !== "settings");
  $("howtoView").classList.toggle("hidden", view !== "howto");
  $("navDashboard").classList.toggle("active", view === "dashboard");
  $("navSettings").classList.toggle("active", view === "settings");
  $("navHowto").classList.toggle("active", view === "howto");
}

// ---------------------------------------------------------------------------
// Pyodide bootstrap (with a visible progress bar on the boot overlay)
// ---------------------------------------------------------------------------
function setBootProgress(pct, msg) {
  const fill = $("bootFill");
  const pctEl = $("bootPct");
  const msgEl = $("bootMsg");
  if (fill) fill.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
  if (msgEl && msg) msgEl.textContent = msg;
}

function hideBootOverlay() {
  const boot = $("boot");
  if (!boot) return;
  boot.classList.add("fade-out");
  setTimeout(() => boot.remove(), 600);
}

// Returns a single shared promise so concurrent callers don't double-boot.
function initPyodide() {
  if (!state.pyPromise) state.pyPromise = bootPyodide();
  return state.pyPromise;
}

async function bootPyodide() {
  setBootProgress(8, "Loading Python runtime…");
  log("Loading Pyodide runtime…");
  state.pyodide = await window.loadPyodide();
  setBootProgress(45, "Runtime ready · fetching PDF tools…");

  log("Installing pdfminer.six (pure-Python) via micropip…");
  await state.pyodide.loadPackage("micropip");
  setBootProgress(60, "Installing pdfminer.six…");
  await state.pyodide.runPythonAsync(`
import micropip
await micropip.install("pdfminer.six")
`);
  setBootProgress(85, "Loading bank parsers…");

  const [pipelineSrc, parsersSrc] = await Promise.all([
    fetch("./py/pipeline.py").then((r) => r.text()),
    fetch("./py/parsers.py").then((r) => r.text()),
  ]);
  state.pyodide.FS.writeFile("pipeline.py", pipelineSrc);
  state.pyodide.FS.writeFile("parsers.py", parsersSrc);
  await state.pyodide.runPythonAsync("import pipeline, parsers");
  setBootProgress(100, "Ready!");

  state.pyReady = true;
  log("Python runtime ready.", "success");
  setStatus("Ready — add cards and fetch.");
}

// ---------------------------------------------------------------------------
// Google OAuth (GIS token client)
// ---------------------------------------------------------------------------
function initTokenClient() {
  const clientId = getClientId();
  if (!clientId) {
    log("No Google Client ID set. Open Settings → Step 1 and paste your OAuth Client ID.", "error");
    return false;
  }
  if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
    log("Google sign-in library is still loading. Please try again in a moment.", "warn");
    return false;
  }
  state.tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: GMAIL_SCOPE,
    callback: (resp) => {
      if (resp.error) {
        log(`OAuth error: ${resp.error} ${resp.error_description || ""}`, "error");
        if (state.tokenReject) { state.tokenReject(new Error(resp.error)); state.tokenReject = null; state.tokenResolve = null; }
        return;
      }
      state.accessToken = resp.access_token;
      setStoredToken(resp.access_token, resp.expires_in);
      log("Connected to Gmail.", "success");
      updateConnUI();
      if (state.tokenResolve) { state.tokenResolve(resp.access_token); state.tokenResolve = null; state.tokenReject = null; }
    },
    error_callback: (err) => {
      if (state.tokenReject) { state.tokenReject(err || new Error("oauth_error")); state.tokenReject = null; state.tokenResolve = null; }
      if (err && err.type === "popup_failed_to_open") {
        log("Sign-in popup was blocked. Allow popups for this site, then click Connect Gmail again.", "error");
      } else if (err && err.type === "popup_closed") {
        log("Sign-in popup was closed before finishing. Click Connect Gmail to retry.", "warn");
      } else {
        log(`Sign-in failed: ${(err && (err.type || err.message)) || "unknown error"}`, "error");
      }
      updateConnUI();
    },
  });
  return true;
}

function connectGmail() {
  if (!getClientId()) {
    log("Set your Google Client ID in Settings first.", "warn");
    showView("settings");
    $("clientIdInput").focus();
    return;
  }
  if (!state.tokenClient && !initTokenClient()) return;
  state.tokenClient.requestAccessToken({ prompt: state.accessToken ? "" : "consent" });
}

function connectFromSettings() {
  const id = $("clientIdInput").value.trim();
  if (!id) {
    $("connStatusSettings").textContent = "Enter your Client ID above first.";
    $("clientIdInput").focus();
    return;
  }
  setClientId(id);
  state.tokenClient = null; // re-init with the (possibly new) client id
  $("connStatusSettings").textContent = "Opening Google sign-in…";
  connectGmail();
}

function ensureToken() {
  return new Promise((resolve, reject) => {
    const stored = getStoredToken();
    if (stored) {
      state.accessToken = stored;
      resolve(stored);
      return;
    }
    if (!getClientId()) {
      reject(new Error("NO_CLIENT"));
      return;
    }
    if (!state.tokenClient && !initTokenClient()) {
      reject(new Error("NO_CLIENT"));
      return;
    }
    state.tokenResolve = resolve;
    state.tokenReject = reject;
    state.tokenClient.requestAccessToken({ prompt: "" });
  });
}

// Connection status UI (dashboard + settings), refreshed on a timer.
function updateConnUI() {
  const token = getStoredToken();
  const expiry = getStoredTokenExpiry();
  const dot = $("connDot");
  const text = $("connText");
  const meta = $("connMeta");
  const btn = $("connectBtn");
  const hasClient = !!getClientId();

  if (token && expiry) {
    state.accessToken = token;
    const mins = Math.max(0, Math.round((expiry - Date.now()) / 60000));
    dot.className = "dot on";
    text.textContent = "Connected to Gmail";
    meta.textContent = `· expires in ~${mins} min`;
    btn.textContent = "Reconnect";
    $("connStatusSettings").textContent = `Connected · expires in ~${mins} min.`;
  } else {
    state.accessToken = null;
    dot.className = "dot off";
    if (!hasClient) {
      text.textContent = "Not set up";
      meta.textContent = "· add your Client ID in Settings";
      btn.textContent = "Set up in Settings";
    } else {
      text.textContent = expiry ? "Session expired" : "Not connected";
      meta.textContent = expiry ? "· reconnect to fetch again" : "";
      btn.textContent = "Connect Gmail";
    }
    if ($("connStatusSettings").textContent.startsWith("Connected")) {
      $("connStatusSettings").textContent = "";
    }
  }
}

// ---------------------------------------------------------------------------
// Gmail API helpers
// ---------------------------------------------------------------------------
async function gmailFetch(path) {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${state.accessToken}` },
  });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${await res.text()}`);
  return res.json();
}

// A card's sender address(es). A single card can receive statements from
// different sender addresses across months (banks rotate them), so we support
// multiple senders and match any of them.
function cardSenders(card) {
  if (card.multiSender && Array.isArray(card.senders) && card.senders.length) {
    return card.senders.map((s) => (s || "").trim()).filter(Boolean);
  }
  return card.sender ? [card.sender.trim()] : [];
}

// Sender and subject are independent, OPTIONAL Gmail filters layered on top of
// the always-on "has a PDF attachment" rule. A card can match by sender, by
// subject, or both. When the flags are unset (older saved cards), fall back to
// whichever field has a value so existing cards keep working.
function cardUseSender(card) {
  return card.useSender !== undefined ? !!card.useSender : cardSenders(card).length > 0;
}
function cardUseSubject(card) {
  return card.useSubject !== undefined ? !!card.useSubject : !!(card.subject && card.subject.trim());
}
// The sender/subject filters that are actually active for this card.
function cardCriteria(card) {
  const senders = cardUseSender(card) ? cardSenders(card) : [];
  const subject = cardUseSubject(card) && card.subject ? card.subject.trim() : "";
  return { senders, subject };
}

async function findStatementMessageIds(senders, subject, limit, lookbackMonths) {
  const parts = ["has:attachment", "filename:pdf", `newer_than:${lookbackMonths}m`];
  const froms = (senders || []).filter(Boolean);
  // Gmail "from:(a OR b)" matches any of the card's sender addresses, so the
  // statements are fetched across every sender and combined into one stream.
  if (froms.length) parts.unshift(`from:(${froms.join(" OR ")})`);
  if (subject) parts.push(`subject:("${subject.replace(/"/g, "")}")`);
  const q = encodeURIComponent(parts.join(" "));
  const list = await gmailFetch(`/messages?q=${q}&maxResults=${limit}`);
  if (!list.messages || !list.messages.length) return [];
  return list.messages.slice(0, limit).map((m) => m.id);
}

function findPdfAttachment(payload) {
  const stack = [payload];
  while (stack.length) {
    const part = stack.pop();
    if (!part) continue;
    const mime = part.mimeType || "";
    const filename = part.filename || "";
    const isPdf = mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
    if (isPdf && part.body && part.body.attachmentId) {
      return { attachmentId: part.body.attachmentId, filename };
    }
    if (part.parts) stack.push(...part.parts);
  }
  return null;
}

function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function downloadStatementPdf(msgId) {
  const msg = await gmailFetch(`/messages/${msgId}?format=full`);
  const att = findPdfAttachment(msg.payload);
  if (!att) return null;
  const data = await gmailFetch(`/messages/${msgId}/attachments/${att.attachmentId}`);
  const dateMs = msg.internalDate ? Number(msg.internalDate) : null;
  const dateLabel = dateMs ? new Date(dateMs).toISOString().slice(0, 10) : "";
  return { bytes: base64UrlToBytes(data.data), filename: att.filename, dateLabel };
}

// ---------------------------------------------------------------------------
// Process a bill / a whole card
// ---------------------------------------------------------------------------
async function processOneBill(card, msgId, label) {
  const pdf = await downloadStatementPdf(msgId);
  if (!pdf) {
    log(`${label}: a matching email had no PDF attachment, skipping.`, "warn");
    return null;
  }
  const billLabel = pdf.dateLabel ? `${label} (${pdf.dateLabel})` : label;
  log(`${billLabel}: downloaded ${pdf.filename} (${pdf.bytes.length} bytes). Parsing…`);

  state.pyodide.globals.set("pdf_bytes", pdf.bytes);
  state.pyodide.globals.set("pdf_password", card.password || "");
  state.pyodide.globals.set("pdf_bank", card.bank || "");
  state.pyodide.globals.set("pdf_label", billLabel);
  const resultJson = await state.pyodide.runPythonAsync(
    "pipeline.process_pdf(pdf_bytes, pdf_password, pdf_bank, pdf_label)"
  );
  const result = JSON.parse(resultJson);

  if (result.raw_text) {
    console.log(`\n===== RAW EXTRACTED TEXT: ${billLabel} =====\n${result.raw_text}\n===== END: ${billLabel} =====\n`);
  }
  if (result.error === "WRONG_PASSWORD") {
    log(`${billLabel}: wrong/missing PDF password.`, "error");
  } else if (result.error) {
    log(`${billLabel}: ${result.error}`, "error");
  } else {
    log(`${billLabel}: parsed ${result.transactions.length} transactions` +
      (result.summary && result.summary.totalDue != null ? `, total due ${result.summary.totalDue}` : ""), "success");
  }
  result.emailDate = pdf.dateLabel || "";
  return result;
}

// Determine a statement's month (YYYY-MM): prefer the closing date of the
// statement period, fall back to the email's received date.
function statementMonthOf(summary, emailDate) {
  const fromPeriod = summary && summary.statementPeriod ? lastDateMonth(summary.statementPeriod) : null;
  if (fromPeriod) return fromPeriod;
  if (emailDate && /^\d{4}-\d{2}/.test(emailDate)) return emailDate.slice(0, 7);
  return "0000-00";
}

const _MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Find the latest date mentioned in a free-form string, return its YYYY-MM.
function lastDateMonth(s) {
  let best = null;
  const consider = (y, mo) => {
    if (!y || !mo || mo < 1 || mo > 12) return;
    const v = y * 12 + mo;
    if (!best || v > best.v) best = { v, ym: `${y}-${String(mo).padStart(2, "0")}` };
  };
  let m;
  const named = /([A-Za-z]{3,9})\s+\d{1,2},?\s*(\d{4})/g; // Month D, YYYY
  while ((m = named.exec(s))) consider(parseInt(m[2], 10), _MONTHS[m[1].slice(0, 3).toLowerCase()]);
  const dayFirst = /\b\d{1,2}\s+([A-Za-z]{3,9}),?\s+(\d{4})\b/g; // D Mon, YYYY (HDFC)
  while ((m = dayFirst.exec(s))) consider(parseInt(m[2], 10), _MONTHS[m[1].slice(0, 3).toLowerCase()]);
  const iso = /(\d{4})-(\d{2})-\d{2}/g;
  while ((m = iso.exec(s))) consider(parseInt(m[1], 10), parseInt(m[2], 10));
  const dmy = /\b\d{1,2}\/(\d{1,2})\/(\d{4})\b/g;
  while ((m = dmy.exec(s))) consider(parseInt(m[2], 10), parseInt(m[1], 10));
  return best ? best.ym : null;
}

// ---------------------------------------------------------------------------
// Active-card management (Add = selection only; Fetch = network)
// ---------------------------------------------------------------------------
function cardById(id) {
  return getCards().find((c) => c.id === id);
}

function reconcileActive() {
  const libIds = new Set(getCards().map((c) => c.id));
  const active = getActiveCardIds().filter((id) => libIds.has(id));
  setActiveCardIds(active);
  for (const id of Object.keys(state.cardData)) {
    if (!libIds.has(id)) delete state.cardData[id];
  }
  return active;
}

// Add a saved card to the dashboard selection. Does NOT fetch.
function addCardToHome() {
  const id = $("cardSelect").value;
  if (!id) {
    log("No saved card selected. Add one in Settings first.", "warn");
    return;
  }
  const card = cardById(id);
  if (!card) return;

  const active = getActiveCardIds();
  if (!active.includes(id)) {
    active.push(id);
    setActiveCardIds(active);
    state.cardStatus[id] = "added · not fetched yet";
    log(`Added "${card.label || card.bank}". Choose statements per card, then click "Fetch statements".`);
  } else {
    log(`"${card.label || card.bank}" is already added.`);
  }
  renderActiveCards();
  updateFetchButton();
}

function removeCardFromHome(id) {
  delete state.cardData[id];
  delete state.cardStatus[id];
  setActiveCardIds(getActiveCardIds().filter((x) => x !== id));
  renderActiveCards();
  updateFetchButton();
  aggregateAndRender();
}

function handleUnauthorized() {
  log("Session expired. Please reconnect to Gmail.", "warn");
  clearStoredToken();
  state.accessToken = null;
  updateConnUI();
  connectGmail();
}

function setFetchingUI(on, msg) {
  state.fetching = on;
  const btn = $("fetchBtn");
  if (on) {
    btn.disabled = true;
    btn.classList.remove("pulse");
    btn.innerHTML = `<span class="spinner"></span>Fetching…`;
    setStatus(`<span class="spinner"></span>${msg || "Fetching statements…"}`, true);
  } else {
    btn.innerHTML = "Step 3 · Fetch statements";
    btn.disabled = getActiveCardIds().length === 0;
  }
}

// Fetch every active card (the only place network calls happen).
async function fetchAll() {
  if (state.fetching) return;
  const active = reconcileActive();
  if (!active.length) {
    log("Add at least one card before fetching.", "warn");
    return;
  }
  try {
    await ensureToken();
  } catch (_) {
    log("Not connected to Gmail. Use Connect Gmail (or set your Client ID in Settings).", "error");
    connectGmail();
    return;
  }
  // Commit any unsaved typing in the look-back box before reading it (the
  // input only fires "change" on blur, so a value typed right before clicking
  // Fetch would otherwise be ignored).
  const lookbackEl = $("lookbackInput");
  if (lookbackEl) setLookbackMonths(lookbackEl.value);
  const count = getStatementsCount();
  const lookbackMonths = getLookbackMonths();
  // Pull a generous candidate pool per card so neither a variant's overlapping
  // emails (subject subset) nor duplicate statement emails for the same month
  // starve a card before it collects `count` distinct statements.
  const pool = Math.min(Math.max(count * 6, 18), 40);
  setFetchingUI(true, "Preparing the analyzer…");
  try {
    await initPyodide();

    // Phase 1 — list candidate message ids for every active card.
    const plans = [];
    for (const id of active) {
      const card = cardById(id);
      if (!card) continue;
      const name = card.label || card.bank;
      const { senders, subject } = cardCriteria(card);
      if (!senders.length && !subject) {
        log(`${name}: enable a sender and/or a subject to match — skipping.`, "warn");
        plans.push({ id, card, name, spec: -1, ids: [] });
        continue;
      }
      state.cardStatus[id] = "searching…";
      renderActiveCards();
      setFetchingUI(true, `Searching ${name}…`);
      let ids = [];
      try {
        const by = [senders.length ? `${senders.length} sender(s)` : null, subject ? "subject" : null].filter(Boolean).join(" + ");
        log(`${name}: searching Gmail (PDF attachments) in the last ${lookbackMonths} month(s) by ${by}…`);
        ids = await findStatementMessageIds(senders, subject, pool, lookbackMonths);
        log(`${name}: found ${ids.length} candidate statement email(s).`);
      } catch (err) {
        if (err.message === "UNAUTHORIZED") { handleUnauthorized(); return; }
        log(`${name}: ${err.message}`, "error");
      }
      // Subject specificity drives the claim order (the more specific subject
      // wins overlapping emails); 0 when subject matching is off.
      plans.push({ id, card, name, spec: subject.length, ids });
    }

    // Phase 2 — claim + parse with the configured last-4 → label mapping.
    // Cards that specify a last-4 are selective, so they claim first; among the
    // rest, the most specific subject wins (handles the subject-subset overlap,
    // e.g. plain ICICI vs Amazon Pay ICICI). A statement is only kept under a
    // card when its extracted last-4 matches the configured one — guaranteeing
    // exactly one ending per label. Each email is parsed at most once (cached)
    // and claimed once (no double-counting across labels).
    const order = [...plans].sort((a, b) => {
      const ah = a.card.last4 ? 0 : 1;
      const bh = b.card.last4 ? 0 : 1;
      return ah - bh || b.spec - a.spec;
    });
    const parseCache = {}; // msgId -> successful parsed result
    const claimed = {};    // msgId -> cardId (the label that owns this statement)

    state.cardData = {};
    for (const p of plans) state.cardData[p.id] = { transactions: [], summaries: [], bills: [] };

    for (const p of order) {
      const d = state.cardData[p.id];
      const want = p.card.last4 || null; // configured 4 digits, or null = accept any
      const crit = cardCriteria(p.card);
      if (!crit.senders.length && !crit.subject) { state.cardStatus[p.id] = "no match criteria"; renderActiveCards(); continue; }
      if (!p.ids.length) {
        state.cardStatus[p.id] = want ? `no ••••${want} statements` : "no statements";
        renderActiveCards();
        continue;
      }
      state.cardStatus[p.id] = "fetching…";
      renderActiveCards();
      let kept = 0;
      const seenMonths = new Set(); // distinct (statement month + ending) kept
      for (const mid of p.ids) {
        if (kept >= count) break;
        if (claimed[mid] !== undefined) continue; // already owned by another label
        setFetchingUI(true, `Fetching ${p.name}${want ? " ••••" + want : ""} (${kept + 1}/${count})…`);
        let result = parseCache[mid];
        if (!result) {
          try {
            result = await processOneBill(p.card, mid, p.name);
          } catch (err) {
            if (err.message === "UNAUTHORIZED") { handleUnauthorized(); return; }
            log(`${p.name}: ${err.message}`, "error");
            continue;
          }
          if (result && !result.error) parseCache[mid] = result;
        }
        if (!result || result.error) continue;

        const extracted = result.cardLast4 || null;
        // Enforce the last-4 → label mapping: skip statements from a different
        // card so this label only ever shows its own ending.
        if (want && extracted && extracted !== want) {
          log(`${p.name}: skipped a statement ending ••••${extracted} (you configured ••••${want}).`);
          continue;
        }
        if (want && !extracted) {
          log(`${p.name}: couldn't read the card number on a statement; including it under ••••${want} (unverified).`, "warn");
        }

        const last4 = extracted || want || null;
        const ym = statementMonthOf(result.summary, result.emailDate);
        // Don't let a duplicate email for the same statement month (e.g. a
        // statement + a reminder, both PDFs) consume one of the `count` slots —
        // the cap counts DISTINCT statements, not emails.
        const monthKey = `${ym}|${last4 || ""}`;
        if (seenMonths.has(monthKey)) {
          claimed[mid] = p.id; // owned, but a duplicate of one we already kept
          log(`${p.name}: skipped a duplicate statement for ${ym === "0000-00" ? "an undated period" : monthLabel(ym)}.`);
          continue;
        }
        seenMonths.add(monthKey);

        claimed[mid] = p.id;
        const billTxns = result.transactions || [];
        // Stamp each transaction with the real card identity (label + last 4)
        // so the combined "by card" view separates variants of the same bank.
        const display = last4 ? `${p.name} •••• ${last4}` : p.name;
        for (const t of billTxns) t.card = display;
        d.transactions.push(...billTxns);
        if (result.summary) d.summaries.push(result.summary);
        d.bills.push({
          msgId: mid,
          last4,
          statementMonth: ym,
          emailDate: result.emailDate || "",
          summary: result.summary || null,
          transactions: billTxns,
        });
        kept += 1;
      }
      if (p.ids.length) {
        log(`${p.name}: kept ${kept} statement(s)${kept >= count ? ` (reached the per-card limit of ${count})` : ""}.`);
      }
      const due = d.summaries.reduce((a, s) => a + (s.totalDue || 0), 0);
      const endings = [...new Set(d.bills.map((b) => b.last4).filter(Boolean))];
      const endLabel = endings.length ? `•••• ${endings.join(", •••• ")} · ` : "";
      state.cardStatus[p.id] = d.bills.length
        ? `${endLabel}${d.transactions.length} txns · due ${inr(due)}`
        : (want ? `no ••••${want} statements` : "no statements");
      renderActiveCards();
    }
    aggregateAndRender();
  } finally {
    setFetchingUI(false);
    if (!state.allTxns.length) {
      setStatus(getActiveCardIds().length ? "No transactions parsed yet." : "Add a card to get started.");
    }
    updateConnUI();
  }
}

// Clear everything fetched + the selected cards, back to a fresh dashboard.
// (Saved cards in Settings are untouched.)
function clearAll() {
  if (state.fetching) return;
  setActiveCardIds([]);
  state.cardData = {};
  state.cardStatus = {};
  state.allTxns = [];
  state.expanded.clear();
  renderActiveCards();
  updateFetchButton();
  $("results").classList.add("hidden");
  $("emptyState").classList.remove("hidden");
  $("monthBreakdown").innerHTML = "";
  setStatus("Cleared. Add cards and fetch.");
  log("Cleared all selected cards and fetched statements.");
}

function updateFetchButton() {
  const hasCards = getActiveCardIds().length > 0;
  const clearBtn = $("clearAllBtn");
  if (clearBtn) clearBtn.disabled = !(hasCards || state.allTxns.length);
  if (state.fetching) return;
  $("fetchBtn").disabled = !hasCards;
}

// ---------------------------------------------------------------------------
// Aggregation + view rendering
// ---------------------------------------------------------------------------
function collectAll() {
  const txns = [];
  const summaries = [];
  for (const id of getActiveCardIds()) {
    const d = state.cardData[id];
    if (d) { txns.push(...d.transactions); summaries.push(...d.summaries); }
  }
  return { txns, summaries };
}

function aggregateAndRender() {
  const { txns } = collectAll();
  state.allTxns = txns;
  const hasData = txns.length > 0;
  $("emptyState").classList.toggle("hidden", hasData);
  $("results").classList.toggle("hidden", !hasData);
  if (!hasData) {
    setStatus(getActiveCardIds().length ? "No transactions parsed yet." : "Add a card to get started.");
    return;
  }
  renderOverview();
  renderMonthBreakdown();
}

function totalDueOf(summaries) {
  return summaries.reduce((a, s) => a + (s.totalDue || 0), 0);
}

// Combined summary at the top of the single view.
function renderOverview() {
  const { txns, summaries } = collectAll();
  if (!txns.length) return;
  // Spend per STATEMENT month (oldest → newest) drives the trend chart, which
  // only appears when 2+ statement months are in view.
  const monthSeries = [...buildStatementMonthGroups()].reverse().map((g) => ({
    label: g.label,
    value: g.cards.reduce(
      (a, c) => a + c.txns.filter((t) => t.type === "debit").reduce((s, t) => s + t.amount, 0), 0),
  }));
  const stats = renderDashboards(txns, { monthSeries });
  const totalDue = totalDueOf(summaries);
  renderKpis([
    { label: "Total amount due", value: inr(totalDue), sub: `${getActiveCardIds().length} card(s)`, tint: "t-purple" },
    { label: "Total spent", value: inr(stats.totalSpend), sub: `${stats.debitCount} purchases`, tint: "t-sky" },
    { label: "Statements", value: String(summaries.length), sub: "bills analysed", tint: "t-green" },
  ]);
  setStatus(`Showing ${stats.txnCount} transactions across ${getActiveCardIds().length} card(s).`);
  log(`Combined: ${stats.txnCount} txns · total spent ${inr(stats.totalSpend)} · total due ${inr(totalDue)}.`, "success");
}

function renderKpis(kpis) {
  $("kpis").innerHTML = kpis
    .map((k) => `
      <div class="stat-card glass ${k.tint}">
        <div class="stat-label">${escapeHtml(k.label)}</div>
        <div class="stat-value">${escapeHtml(k.value)}</div>
        <div class="stat-sub">${escapeHtml(k.sub)}</div>
      </div>`)
    .join("");
  $("kpis").querySelectorAll(".stat-value").forEach((el) => countUp(el, el.textContent));
}

function countUp(el, text) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const m = String(text).replace(/,/g, "").match(/^(\D*)(\d+)(\D*)$/);
  if (reduce || !m) { el.textContent = text; return; }
  const prefix = m[1], target = parseInt(m[2], 10), suffix = m[3];
  const isCurrency = prefix.includes("\u20b9");
  const dur = 600, start = performance.now();
  function frame(now) {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    const val = Math.round(target * eased);
    el.textContent = prefix + (isCurrency ? val.toLocaleString("en-IN") : String(val)) + suffix;
    if (p < 1) requestAnimationFrame(frame);
    else el.textContent = text;
  }
  requestAnimationFrame(frame);
}

function txnRowsHtml(rows, showCard = true) {
  return rows
    .map((t) => {
      const friendly = friendlyMerchant(t.merchant);
      const cat = prettyCategory(t);
      const sign = t.type === "credit" ? "+" : "-";
      const cls = t.type === "credit" ? "amt-credit" : "amt-debit";
      const rawNote = friendly.toLowerCase() !== (t.merchant || "").toLowerCase()
        ? `<span class="merchant-raw">${escapeHtml(t.merchant || "")}</span>` : "";
      const cardCell = showCard ? `<td>${escapeHtml(t.card || "")}</td>` : "";
      return `
      <tr>
        <td>${escapeHtml(t.date || "-")}</td>
        <td class="merchant-cell">${escapeHtml(friendly)}${rawNote}</td>
        <td><span class="cat-tag">${escapeHtml(cat)}</span></td>
        ${cardCell}
        <td class="num ${cls}">${sign}${inr(t.amount)}</td>
      </tr>`;
    })
    .join("");
}

// ----- Single-view breakdown: month → card, with expandable transactions -----
// Build: month (desc) -> [{ cardId, name, txns }] in active-card order.
// Group by STATEMENT month (one email = one statement). A statement's
// transactions stay together under its statement month even if individual
// transaction dates fall in an earlier month.
function buildStatementMonthGroups() {
  const activeIds = getActiveCardIds();
  // Key each row by card + last-4 digits so statements from distinct physical
  // cards (e.g. plain ICICI vs Amazon Pay ICICI) are clubbed by their ending,
  // never merged just because they share a bank/label.
  const months = {}; // ym -> { `cardId|last4` -> { cardId, last4, name, txns[], summaries[], period, order } }
  for (const id of activeIds) {
    const d = state.cardData[id];
    if (!d || !d.bills) continue;
    const c = cardById(id);
    const name = c ? (c.label || c.bank) : id;
    const order = activeIds.indexOf(id);
    for (const bill of d.bills) {
      const ym = bill.statementMonth || "0000-00";
      const last4 = bill.last4 || "";
      const key = `${id}|${last4}`;
      months[ym] = months[ym] || {};
      if (!months[ym][key]) months[ym][key] = { cardId: id, last4, name, txns: [], summaries: [], period: null, order };
      const grp = months[ym][key];
      grp.txns.push(...bill.transactions);
      if (bill.summary) {
        grp.summaries.push(bill.summary);
        if (!grp.period && bill.summary.statementPeriod) grp.period = bill.summary.statementPeriod;
      }
    }
  }
  return Object.keys(months)
    .sort((a, b) => b.localeCompare(a))
    .map((ym) => ({
      ym,
      label: ym === "0000-00" ? "Undated statement" : monthLabel(ym),
      cards: Object.values(months[ym]).sort((a, b) => a.order - b.order || a.last4.localeCompare(b.last4)),
    }));
}

function renderMonthBreakdown() {
  const container = $("monthBreakdown");
  const groups = buildStatementMonthGroups();
  container.innerHTML = groups
    .map((g) => {
      const monthSpend = g.cards.reduce(
        (a, c) => a + c.txns.filter((t) => t.type === "debit").reduce((s, t) => s + t.amount, 0), 0);
      const monthTxns = g.cards.reduce((a, c) => a + c.txns.length, 0);
      const cardsHtml = g.cards
        .map((c) => {
          const key = `${g.ym}|${c.cardId}|${c.last4}`;
          const open = state.expanded.has(key);
          const debit = c.txns.filter((t) => t.type === "debit").reduce((s, t) => s + t.amount, 0);
          // Show the due amount whenever a statement actually reported one,
          // even when it's zero (a fully-paid card still shows ₹0.00).
          const hasDue = c.summaries.some((x) => x.totalDue != null);
          const due = c.summaries.reduce((s, x) => s + (x.totalDue || 0), 0);
          // Highest-value transactions first (descending amount).
          const rows = [...c.txns].sort((a, b) => (b.amount || 0) - (a.amount || 0));
          const sub = c.period
            ? `${escapeHtml(c.period)} · ${c.txns.length} txn${c.txns.length === 1 ? "" : "s"}`
            : `${c.txns.length} transaction${c.txns.length === 1 ? "" : "s"}`;
          const dueMetric = hasDue
            ? `<span class="mc-metric">
                 <span class="mc-metric-label">Due Amount</span>
                 <span class="mc-metric-value">${inr(due)}</span>
               </span>`
            : "";
          return `
          <div class="mc-card glass ${open ? "open" : ""}" data-key="${escapeHtml(key)}">
            <button class="mc-head" data-toggle="${escapeHtml(key)}">
              <span class="mc-left">
                <span class="mc-name">${escapeHtml(c.name)}${c.last4 ? ` <span class="mc-card-end">•••• ${escapeHtml(c.last4)}</span>` : ""}</span>
                <span class="mc-sub">${sub}</span>
              </span>
              <span class="mc-right">
                ${dueMetric}
                <span class="mc-metric">
                  <span class="mc-metric-label">Total Spent Amount</span>
                  <span class="mc-metric-value">${inr(debit)}</span>
                </span>
                <span class="mc-chevron">&#9660;</span>
              </span>
            </button>
            <div class="mc-collapse">
              <div class="mc-collapse-inner">
                <div class="table-scroll">
                  <table class="txn-table">
                    <thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th class="num">Amount</th></tr></thead>
                    <tbody>${txnRowsHtml(rows, false)}</tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>`;
        })
        .join("");
      return `
        <div class="month-section">
          <div class="month-head">
            <div class="month-title">${escapeHtml(g.label)}</div>
            <div class="month-meta">${inr(monthSpend)} spent · ${monthTxns} transaction${monthTxns === 1 ? "" : "s"} · ${g.cards.length} card${g.cards.length === 1 ? "" : "s"}</div>
          </div>
          ${cardsHtml}
        </div>`;
    })
    .join("");
}

function toggleBreakdown(key) {
  if (state.expanded.has(key)) state.expanded.delete(key);
  else state.expanded.add(key);
  const el = document.querySelector(`.mc-card[data-key="${CSS.escape(key)}"]`);
  if (el) el.classList.toggle("open", state.expanded.has(key));
}

function monthLabel(ym) {
  if (!/^\d{4}-\d{2}$/.test(ym)) return ym;
  const [y, m] = ym.split("-");
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------------------
// Dashboard card controls (dropdown, bills, chips)
// ---------------------------------------------------------------------------
function renderCardSelect() {
  const sel = $("cardSelect");
  const cards = getCards();
  const prev = sel.value;
  if (!cards.length) {
    sel.innerHTML = `<option value="">No saved cards — add some in Settings</option>`;
  } else {
    sel.innerHTML = cards.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.label || c.bank)}</option>`).join("");
    if (prev && cards.some((c) => c.id === prev)) sel.value = prev;
  }
}

// Single global "statements per card" selector.
function renderCountSelect() {
  const sel = $("countSelect");
  const current = getStatementsCount();
  sel.innerHTML = Array.from({ length: MAX_BILLS_PER_CARD }, (_, k) => k + 1)
    .map((n) => `<option value="${n}" ${n === current ? "selected" : ""}>${n}</option>`)
    .join("");
}

function renderActiveCards() {
  const wrap = $("activeCards");
  const active = getActiveCardIds();
  if (!active.length) {
    wrap.innerHTML = `<span class="caption">No cards added yet. Pick a saved card above and click “+ Add card”.</span>`;
    return;
  }
  wrap.innerHTML = active
    .map((id) => {
      const card = cardById(id);
      if (!card) return "";
      const status = state.cardStatus[id] || "ready to fetch";
      const fetching = status === "fetching…";
      return `
      <div class="chip ${fetching ? "fetching" : ""}">
        <div class="chip-main">
          <span class="chip-label">${escapeHtml(card.label || card.bank)}</span>
          <span class="chip-sub">${escapeHtml(status)}</span>
        </div>
        <button class="btn-icon-danger" data-remove="${escapeHtml(id)}" title="Remove">&times;</button>
      </div>`;
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Settings: saved-cards table
// ---------------------------------------------------------------------------
function renderCardsTable() {
  const tbody = $("cardsBody");
  tbody.innerHTML = "";
  getCards().forEach((card, i) => {
    const tr = document.createElement("tr");
    const bankOptions = SUPPORTED_BANKS.map((b) => `<option value="${b}" ${b === card.bank ? "selected" : ""}>${b}</option>`).join("");
    const useSnd = cardUseSender(card);
    const useSub = cardUseSubject(card);
    const senderField = card.multiSender
      ? `<textarea data-i="${i}" data-k="sendersText" class="senders-text" rows="2" placeholder="one sender per line, e.g.\nstatements@bank.com\nalerts@bank.com">${escapeHtml((card.senders || []).join("\n"))}</textarea>`
      : `<input data-i="${i}" data-k="sender" placeholder="statements@bank.com" value="${escapeHtml(card.sender || "")}" />`;
    const senderCell = `
        <label class="match-toggle"><input type="checkbox" data-i="${i}" data-k="useSender" ${useSnd ? "checked" : ""} /> Match by sender email</label>
        ${useSnd ? `
        <label class="multi-toggle"><input type="checkbox" data-i="${i}" data-k="multiSender" ${card.multiSender ? "checked" : ""} /> Multiple senders</label>
        ${senderField}` : ""}`;
    const subjectCell = `
        <label class="match-toggle"><input type="checkbox" data-i="${i}" data-k="useSubject" ${useSub ? "checked" : ""} /> Match by subject</label>
        ${useSub ? `<input data-i="${i}" data-k="subject" placeholder="ICICI Bank Credit Card Statement for the period" value="${escapeHtml(card.subject || "")}" />` : ""}`;
    tr.innerHTML = `
      <td><input data-i="${i}" data-k="label" value="${escapeHtml(card.label || "")}" /></td>
      <td><input data-i="${i}" data-k="last4" class="last4-input" inputmode="numeric" maxlength="4" pattern="\\d{4}" placeholder="1234" value="${escapeHtml(card.last4 || "")}" /></td>
      <td><select data-i="${i}" data-k="bank">${bankOptions}</select></td>
      <td>${senderCell}</td>
      <td>${subjectCell}</td>
      <td><input data-i="${i}" data-k="password" type="password" placeholder="PDF password" value="${escapeHtml(card.password || "")}" /></td>
      <td><button class="btn-icon-danger" data-del="${i}">&times;</button></td>`;
    tbody.appendChild(tr);
  });
}

function readCardsFromTable() {
  const cards = getCards();
  document.querySelectorAll("#cardsBody [data-i]").forEach((el) => {
    const i = Number(el.dataset.i);
    const k = el.dataset.k;
    if (!cards[i]) cards[i] = { id: genId(), bank: "HDFC", sender: "", subject: "", password: "", label: "", last4: "", multiSender: false, senders: [], useSender: false, useSubject: true };
    if (k === "multiSender" || k === "useSender" || k === "useSubject") {
      cards[i][k] = el.checked;
    } else if (k === "sendersText") {
      // One sender per line (commas also accepted); trimmed, blanks dropped.
      cards[i].senders = el.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    } else if (k === "last4") {
      cards[i][k] = el.value.replace(/\D/g, "").slice(0, 4); // digits only, max 4
    } else {
      cards[i][k] = el.value;
    }
  });
  return cards;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmt(n) {
  if (n == null) return "-";
  return "\u20b9" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Briefly show a green "Saved" next to the Save button for ~2 seconds.
let _savedFlashTimer = null;
function flashSaved() {
  const el = $("savedFlash");
  if (!el) return;
  el.classList.add("show");
  if (_savedFlashTimer) clearTimeout(_savedFlashTimer);
  _savedFlashTimer = setTimeout(() => el.classList.remove("show"), 2000);
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
function init() {
  applyTheme(getTheme());
  $("clientIdInput").value = getClientId();
  $("lookbackInput").value = getLookbackMonths();
  renderCardsTable();
  reconcileActive();
  renderCardSelect();
  renderCountSelect();
  renderActiveCards();
  updateFetchButton();
  updateConnUI();

  // Kick off the Python runtime immediately and reveal the app when ready.
  initPyodide()
    .then(hideBootOverlay)
    .catch((err) => {
      setBootProgress(100, "Couldn't load the runtime — check your connection.");
      log(`Failed to load Python runtime: ${err && err.message ? err.message : err}`, "error");
      setTimeout(hideBootOverlay, 1500);
    });

  // Theme toggle
  document.querySelectorAll("#modeToggle .mode-toggle-option").forEach((b) => {
    b.addEventListener("click", () => applyTheme(b.dataset.mode));
  });

  // Nav tabs
  $("navDashboard").addEventListener("click", () => showView("dashboard"));
  $("navSettings").addEventListener("click", () => showView("settings"));
  $("navHowto").addEventListener("click", () => showView("howto"));

  // Connection
  $("connectBtn").addEventListener("click", connectGmail);
  $("connectBtnSettings").addEventListener("click", connectFromSettings);

  // Settings save / cards
  $("saveSettingsBtn").addEventListener("click", () => {
    const cards = readCardsFromTable();
    // A last-4 value, when given, must be exactly 4 digits.
    const bad = cards.find((c) => c.last4 && !/^\d{4}$/.test(c.last4));
    if (bad) {
      log(`"${bad.label || bad.bank}": "Last 4 digits" must be exactly 4 numbers (or left blank).`, "error");
      return;
    }
    // Every card needs at least one active matching criterion (sender or subject).
    const noMatch = cards.find((c) => {
      const { senders, subject } = cardCriteria(c);
      return !senders.length && !subject;
    });
    if (noMatch) {
      log(`"${noMatch.label || noMatch.bank}": enable a sender match and/or a subject match (with a value).`, "error");
      return;
    }
    setClientId($("clientIdInput").value);
    setCards(cards);
    state.tokenClient = null;
    reconcileActive();
    renderCardSelect();
    renderActiveCards();
    updateFetchButton();
    updateConnUI();
    log("Settings saved.", "success");
    flashSaved();
  });
  $("addCardBtn").addEventListener("click", () => {
    const cards = readCardsFromTable();
    cards.push({ id: genId(), bank: "HDFC", sender: "", subject: "", password: "", label: "New Card", last4: "", multiSender: false, senders: [], useSender: false, useSubject: true });
    setCards(cards);
    renderCardsTable();
    renderCardSelect();
  });
  // Restrict the "Last 4 digits" inputs to digits as the user types.
  $("cardsBody").addEventListener("input", (e) => {
    if (e.target.dataset && e.target.dataset.k === "last4") {
      const clean = e.target.value.replace(/\D/g, "").slice(0, 4);
      if (clean !== e.target.value) e.target.value = clean;
    }
  });
  // Toggling "Multiple senders" swaps the single input for a multi-line list
  // (and vice-versa), seeding/collapsing the values so nothing is lost.
  $("cardsBody").addEventListener("change", (e) => {
    const k = e.target.dataset && e.target.dataset.k;
    if (k === "multiSender" || k === "useSender" || k === "useSubject") {
      const cards = readCardsFromTable();
      const i = Number(e.target.dataset.i);
      const c = cards[i];
      if (c && k === "multiSender") {
        if (c.multiSender) {
          if (!Array.isArray(c.senders) || !c.senders.length) c.senders = c.sender ? [c.sender] : [];
        } else if (Array.isArray(c.senders) && c.senders.length) {
          c.sender = c.senders[0];
        }
      }
      setCards(cards);
      renderCardsTable();
    }
  });
  $("cardsBody").addEventListener("click", (e) => {
    if (e.target.dataset.del != null) {
      const cards = readCardsFromTable();
      cards.splice(Number(e.target.dataset.del), 1);
      setCards(cards);
      renderCardsTable();
      reconcileActive();
      renderCardSelect();
      renderActiveCards();
      updateFetchButton();
    }
  });

  // Dashboard card selection
  $("addToHomeBtn").addEventListener("click", addCardToHome);
  $("countSelect").addEventListener("change", (e) => {
    setStatementsCount(e.target.value);
    renderCountSelect();
  });
  $("lookbackInput").addEventListener("change", (e) => {
    setLookbackMonths(e.target.value);
    e.target.value = getLookbackMonths();
  });
  $("activeCards").addEventListener("click", (e) => {
    const id = e.target.dataset.remove;
    if (id != null) removeCardFromHome(id);
  });
  $("fetchBtn").addEventListener("click", fetchAll);
  $("clearAllBtn").addEventListener("click", clearAll);

  // Expand / collapse a card's transactions in the month breakdown.
  $("monthBreakdown").addEventListener("click", (e) => {
    const head = e.target.closest("[data-toggle]");
    if (head) toggleBreakdown(head.dataset.toggle);
  });

  // Restore session
  if (getStoredToken()) {
    log("Gmail session restored. Add cards and hit Fetch statements.", "success");
  } else {
    log("App loaded. Settings → enter Client ID → Connect Gmail → add cards → Fetch.");
  }
  setStatus("Starting up…");

  // Live connection-expiry refresh.
  setInterval(updateConnUI, 30000);
}

window.addEventListener("DOMContentLoaded", init);
