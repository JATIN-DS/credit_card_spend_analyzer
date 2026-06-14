// Chart.js dashboards + display helpers built from the merged transactions.
// Chart.js is loaded globally from a CDN in index.html (window.Chart).

// ---------------------------------------------------------------------------
// Friendly merchant names (hard-coded). Bank statements show cryptic strings
// like "CASHFREE*FLIPKART INTE,BENGALURU" or "PTM*FLIPKART INTERNET,NOIDA".
// We map these to clean, human names. Order matters: more specific brands are
// checked first (e.g. FLIPKART before generic gateways like CASHFREE/PTM/PAY).
// ---------------------------------------------------------------------------
const MERCHANT_ALIASES = [
  { keys: ["flipkart"], name: "Flipkart" },
  { keys: ["meesho"], name: "Meesho" },
  { keys: ["amazon"], name: "Amazon" },
  { keys: ["myntra"], name: "Myntra" },
  { keys: ["ajio"], name: "Ajio" },
  { keys: ["nykaa"], name: "Nykaa" },
  { keys: ["swiggy"], name: "Swiggy" },
  { keys: ["zomato"], name: "Zomato" },
  { keys: ["dominos", "domino"], name: "Domino's" },
  { keys: ["mcdonald"], name: "McDonald's" },
  { keys: ["starbucks"], name: "Starbucks" },
  { keys: ["uber"], name: "Uber" },
  { keys: ["ola"], name: "Ola" },
  { keys: ["rapido"], name: "Rapido" },
  { keys: ["irctc"], name: "IRCTC (Railways)" },
  { keys: ["makemytrip"], name: "MakeMyTrip" },
  { keys: ["goibibo"], name: "Goibibo" },
  { keys: ["indigo"], name: "IndiGo" },
  { keys: ["vistara"], name: "Vistara" },
  { keys: ["oyo"], name: "OYO" },
  { keys: ["bigbasket"], name: "BigBasket" },
  { keys: ["blinkit", "grofers"], name: "Blinkit" },
  { keys: ["zepto"], name: "Zepto" },
  { keys: ["dmart", "d mart"], name: "DMart" },
  { keys: ["reliance fresh", "reliance retail", "reliance smart"], name: "Reliance Retail" },
  { keys: ["netflix"], name: "Netflix" },
  { keys: ["spotify"], name: "Spotify" },
  { keys: ["hotstar", "disney"], name: "Disney+ Hotstar" },
  { keys: ["prime video", "amazon prime"], name: "Amazon Prime" },
  { keys: ["youtube"], name: "YouTube" },
  { keys: ["bookmyshow"], name: "BookMyShow" },
  { keys: ["jio"], name: "Jio" },
  { keys: ["airtel"], name: "Airtel" },
  { keys: ["vodafone", "vi "], name: "Vi" },
  { keys: ["apollo"], name: "Apollo" },
  { keys: ["pharmeasy"], name: "PharmEasy" },
  { keys: ["1mg", "tata 1mg"], name: "Tata 1mg" },
  { keys: ["petro", "petrol", "hpcl", "iocl", "bpcl", "indian oil", "bharat petroleum", "shell", "fuel"], name: "Fuel / Petrol" },
  { keys: ["cashback credit", "cashback"], name: "Cashback Credit" },
  { keys: ["payment received", "neft", "imps", "upi payment", "autopay"], name: "Card Payment" },
];

// Payment-gateway prefixes that wrap the real merchant (we strip these).
const GATEWAY_PREFIXES = ["cashfree*", "ptm*", "pay*", "bbps*", "razp*", "razorpay*", "payu*", "upi*", "ccav*", "billdesk*"];

function friendlyMerchant(raw) {
  if (!raw) return "Unknown";
  const lower = raw.toLowerCase();

  for (const alias of MERCHANT_ALIASES) {
    if (alias.keys.some((k) => lower.includes(k))) return alias.name;
  }

  // Generic cleanup: strip gateway prefix, drop trailing ",CITY", title-case.
  let cleaned = raw.trim();
  const lc = cleaned.toLowerCase();
  for (const p of GATEWAY_PREFIXES) {
    if (lc.startsWith(p)) {
      cleaned = cleaned.slice(p.length);
      break;
    }
  }
  if (cleaned.includes("*")) cleaned = cleaned.split("*").pop();
  cleaned = cleaned.split(",")[0].trim(); // drop location suffix
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  // Title-case words while keeping short all-caps acronyms readable.
  cleaned = cleaned
    .toLowerCase()
    .split(" ")
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
  return cleaned || "Unknown";
}

// ---------------------------------------------------------------------------
// Category keyword fallback (used when the bank didn't provide a category).
// ---------------------------------------------------------------------------
const CATEGORY_RULES = [
  { category: "Food & Dining", keywords: ["swiggy", "zomato", "restaurant", "cafe", "food", "dominos", "mcdonald", "kfc", "starbucks", "eatery", "dine"] },
  { category: "Groceries", keywords: ["bigbasket", "blinkit", "zepto", "grofers", "dmart", "grocery", "supermarket", "reliance fresh", "more retail"] },
  { category: "Shopping", keywords: ["amazon", "flipkart", "myntra", "ajio", "nykaa", "meesho", "shop", "retail", "store", "mall"] },
  { category: "Travel", keywords: ["uber", "ola", "rapido", "irctc", "makemytrip", "goibibo", "indigo", "vistara", "air", "flight", "railway", "metro", "travel", "hotel", "oyo"] },
  { category: "Fuel", keywords: ["fuel", "petrol", "diesel", "hpcl", "iocl", "bpcl", "shell", "indian oil", "bharat petroleum"] },
  { category: "Utilities & Bills", keywords: ["electricity", "water", "gas", "broadband", "airtel", "jio", "vodafone", "bsnl", "recharge", "bill", "dth", "tata power"] },
  { category: "Entertainment", keywords: ["netflix", "prime video", "hotstar", "spotify", "bookmyshow", "pvr", "inox", "youtube", "gaming"] },
  { category: "Health", keywords: ["pharmacy", "apollo", "medplus", "hospital", "clinic", "medical", "1mg", "pharmeasy", "diagnostic"] },
];

function categorize(merchant) {
  const m = (merchant || "").toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((k) => m.includes(k))) return rule.category;
  }
  return "Other";
}

// Title-case the bank's own category (e.g. "Dept Stores" stays readable).
function prettyCategory(t) {
  return t.category || categorize(t.merchant);
}

// ---------------------------------------------------------------------------
// Formatting + chart plumbing
// ---------------------------------------------------------------------------
const PALETTE = [
  "#6C63FF", "#38BDF8", "#FBBF24", "#4ADE80", "#F472B6",
  "#A78BFA", "#22D3EE", "#FB923C", "#34D399", "#E879F9",
];

function inr(n) {
  return "\u20b9" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

// Read live theme colors so charts adapt to dark/light mode.
function _cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function _txtColor() { return _cssVar("--chart-text", "#F0F0F5"); }
function _subColor() { return _cssVar("--chart-sub", "#94a3b8"); }
function _gridColor() { return _cssVar("--chart-grid", "rgba(255,255,255,0.08)"); }

const _charts = {};
function _render(canvasId, config) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  if (_charts[canvasId]) _charts[canvasId].destroy();
  _charts[canvasId] = new window.Chart(ctx, config);
}

function _show(boxId, visible) {
  const el = document.getElementById(boxId);
  if (el) el.style.display = visible ? "" : "none";
}

// Destroy chart instances whose canvas ids share a prefix (e.g. grouped views),
// so re-renders with fewer groups don't leave orphaned Chart.js instances.
function clearCharts(prefix) {
  Object.keys(_charts).forEach((id) => {
    if (id.startsWith(prefix)) {
      _charts[id].destroy();
      delete _charts[id];
    }
  });
}

function _baseOpts(title) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      title: { display: true, text: title, color: _txtColor(), font: { size: 14, weight: "600" } },
      tooltip: { callbacks: { label: (c) => inr(c.parsed.y ?? c.parsed.x ?? c.parsed) } },
    },
    scales: {
      x: { ticks: { color: _subColor() }, grid: { color: _gridColor() } },
      y: { beginAtZero: true, ticks: { color: _subColor(), callback: (v) => inr(v) }, grid: { color: _gridColor() } },
    },
  };
}

// txns: array of {date, merchant, amount, type, card, category}
// opts: { monthSeries: [{ label, value }] sorted by statement month ascending }
function renderDashboards(txns, opts = {}) {
  const debits = txns.filter((t) => t.type === "debit");

  // 1) Spend by card (one bar per real card identity, incl. last-4 variants)
  const byCard = {};
  for (const t of debits) byCard[t.card] = (byCard[t.card] || 0) + t.amount;
  const cardLabels = Object.keys(byCard);
  _show("boxByCard", cardLabels.length > 0);
  _render("chartByCard", {
    type: "bar",
    data: {
      labels: cardLabels,
      datasets: [{ data: cardLabels.map((k) => byCard[k]), backgroundColor: cardLabels.map((_, i) => PALETTE[i % PALETTE.length]), borderRadius: 6 }],
    },
    options: _baseOpts("Spend by card"),
  });

  // 2) Spend over time — only when 2+ statement months are in view.
  const monthSeries = (opts.monthSeries || []).filter((m) => m && m.label);
  const showTrend = monthSeries.length > 1;
  _show("boxByMonth", showTrend);
  if (showTrend) {
    _render("chartByMonth", {
      type: "line",
      data: {
        labels: monthSeries.map((m) => m.label),
        datasets: [{ data: monthSeries.map((m) => m.value), borderColor: PALETTE[0], backgroundColor: "rgba(99,102,241,0.15)", fill: true, tension: 0.25, pointRadius: 4 }],
      },
      options: _baseOpts("How your spend changed over time"),
    });
  }

  const byCat = {};
  for (const t of debits) {
    const c = prettyCategory(t);
    byCat[c] = (byCat[c] || 0) + t.amount;
  }
  const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  return {
    totalSpend: debits.reduce((a, b) => a + b.amount, 0),
    txnCount: txns.length,
    debitCount: debits.length,
    creditTotal: txns.filter((t) => t.type === "credit").reduce((a, b) => a + b.amount, 0),
    byCard,
    byCat,
    topCategory: catEntries[0] ? catEntries[0][0] : "-",
  };
}

// ---------------------------------------------------------------------------
// Lightweight stats used by the grouped (By card / By month) views.
// ---------------------------------------------------------------------------
function computeStats(txns) {
  const debits = txns.filter((t) => t.type === "debit");
  const byCat = {};
  for (const t of debits) {
    const c = prettyCategory(t);
    byCat[c] = (byCat[c] || 0) + t.amount;
  }
  const byMerchant = {};
  for (const t of debits) {
    const name = friendlyMerchant(t.merchant);
    byMerchant[name] = (byMerchant[name] || 0) + t.amount;
  }
  const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const merchEntries = Object.entries(byMerchant).sort((a, b) => b[1] - a[1]);
  return {
    totalSpend: debits.reduce((a, b) => a + b.amount, 0),
    creditTotal: txns.filter((t) => t.type === "credit").reduce((a, b) => a + b.amount, 0),
    txnCount: txns.length,
    debitCount: debits.length,
    topCategory: catEntries[0] ? catEntries[0][0] : "-",
    topMerchant: merchEntries[0] ? merchEntries[0][0] : "-",
    catEntries,
  };
}

// Render a compact category doughnut into an already-existing canvas element id.
// Used by the grouped views (one per card / per month).
function renderCategoryDoughnut(canvasId, txns, title) {
  const stats = computeStats(txns);
  const entries = stats.catEntries;
  _render(canvasId, {
    type: "doughnut",
    data: {
      labels: entries.map((e) => e[0]),
      datasets: [{ data: entries.map((e) => e[1]), backgroundColor: entries.map((_, i) => PALETTE[i % PALETTE.length]), borderWidth: 0 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "right", labels: { color: _txtColor(), boxWidth: 10, padding: 8, font: { size: 11 } } },
        title: { display: !!title, text: title || "", color: _txtColor(), font: { size: 13, weight: "600" } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const total = c.dataset.data.reduce((a, b) => a + b, 0);
              const pct = total ? (c.parsed / total) * 100 : 0;
              return `${c.label}: ${inr(c.parsed)} (${pct.toFixed(1)}%)`;
            },
          },
        },
      },
    },
  });
}

export {
  renderDashboards,
  computeStats,
  renderCategoryDoughnut,
  clearCharts,
  categorize,
  friendlyMerchant,
  prettyCategory,
  inr,
};
