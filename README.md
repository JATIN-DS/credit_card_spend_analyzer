# Credit Card Spend Analyzer

A **100% free, fully local, browser-only** tool that pulls your credit‑card
statement PDFs straight from Gmail, opens the password‑protected files, extracts
every transaction, and shows you a combined view of your spending across all of
your cards.

Everything runs **inside your browser tab**. No server, no backend, no upload.
The PDFs are parsed in‑browser with Python (via [Pyodide](https://pyodide.org/) +
[`pdfminer.six`](https://github.com/pdfminer/pdfminer.six)), and the only network
calls the page makes are the normal authenticated requests to **your own** Gmail.

---

## ▶️ Use it instantly (hosted, nothing to install)

The app is hosted for free on GitHub Pages. Just open and bookmark:

### **https://jatin-ds.github.io/credit_card_spend_analyzer/**

No terminal, no download, no local server — it works from any browser and your
settings stay saved in that browser. You only need to do the **one‑time Google
OAuth setup** below once, and when creating the Client ID add
`https://jatin-ds.github.io` as an Authorized JavaScript origin.

> Prefer to run it locally/offline instead? See **[Run locally](#part-2--run-locally-optional)**.

---

## What it does

1. **Fetches** your statement emails from Gmail for each card you configure.
   Every search is hard‑restricted to emails that carry a **PDF attachment**.
2. **Decrypts** each password‑protected statement PDF with the password you save
   locally.
3. **Extracts** the statement summary (total due, minimum due, due date, billing
   period) and the full transaction table using a per‑bank Python parser.
4. **Disambiguates** cards that share a sender/subject by reading the masked card
   number and matching the **last 4 digits** you configured.
5. **Visualizes** combined spending: KPI cards (total due, total spent,
   statements analysed), a *Spent by card* chart, a *Spend over time* trend, and
   an expandable month → card → transactions breakdown.

### Privacy & cost

- **Free forever.** The Gmail API is free for personal use; Pyodide,
  `pdfminer.six`, and Chart.js are open source. **No credit card** is needed on
  your Google account.
- **Private by design.** Statement PDFs and their contents never leave your
  browser's memory. Your OAuth Client ID, card passwords, and settings are stored
  only in this browser's `localStorage`, on your machine.

---

## Quick start (new user)

There are two one‑time pieces of setup: get a Google OAuth Client ID, then run
the page from `http://localhost:8000`. The in‑app **How to** tab walks through
the same steps if you prefer to follow along in the UI.

### Part 1 — Create a Google OAuth Client ID (free, ~5 min, no billing)

You need a Client ID so the page can read *your* Gmail with your permission.

1. Go to <https://console.cloud.google.com> and sign in.
2. **Create a project**: project dropdown (top bar) → **New Project** → name it
   (e.g. `spend-analyzer`) → **Create**.
3. **Enable the Gmail API**: search bar → "Gmail API" → **Enable**
   (or *APIs & Services → Library → Gmail API → Enable*).
4. **Configure the consent screen**: *APIs & Services → OAuth consent screen*
   - User type: **External** → Create
   - Fill the app name + your email in the required fields → Save and Continue
   - **Scopes**: add `https://www.googleapis.com/auth/gmail.readonly` → Save
   - **Test users**: add your own Gmail address → Save
   - Leave the app in **Testing** mode (no Google verification needed).
5. **Create the credential**: *APIs & Services → Credentials → Create
   Credentials → OAuth client ID*
   - Application type: **Web application**
   - **Authorized JavaScript origins** → add `https://jatin-ds.github.io` (the
     hosted app). If you'll also run it locally, add `http://localhost:8000` too.
   - **Create**, then copy the **Client ID** (looks like
     `1234567890-abcd.apps.googleusercontent.com`). No client secret is needed.

> None of these steps ask for a credit card. Billing is only required for paid
> Google Cloud products, which this app does not use.

### Part 2 — Run locally (optional)

You don't need this if you use the **hosted URL** above. But to run it on your
own machine (offline), OAuth requires a registered origin, so serve it over
`http://localhost:8000` (not as a `file://` page):

```bash
# from the project folder
python3 -m http.server 8000
```

Then open <http://localhost:8000> in your browser. The first load shows a brief
progress bar while the Python runtime initialises.

### Part 3 — Configure your cards

Open the **Settings** tab and:

1. Paste your **Google OAuth Client ID**.
2. Pick **Statements per card** — how many of the most recent statements to fetch
   for each card.
3. Set the **Look‑back (months)** window — statements older than this are never
   fetched (default **6**).
4. Fill the **Cards** table (one row per physical card):

   | Field | What to enter |
   |-------|----------------|
   | **Label** | Any name you like, e.g. `Amazon Pay ICICI`. |
   | **Last 4 digits** | The card's last 4 digits (optional). If set, only statements whose PDF ends in these digits are attributed to this card — this disambiguates multiple cards from the same bank/sender. |
   | **Bank** | The issuer: HDFC, AXIS, ICICI, SBI, or AMEX. |
   | **Sender email match** | *(toggle)* Match emails from a sender address, e.g. `cc.statements@axisbank.com`. Turn on **Multiple senders** if a card's statements arrive from different addresses across months (one address per line). |
   | **Subject match** | *(toggle)* Match emails whose subject contains a phrase, e.g. `ICICI Bank Credit Card Statement for the period`. |
   | **PDF password** | The password your bank uses to encrypt the statement PDF. |

   You can enable **sender match**, **subject match**, or **both** — at least one
   is required. Regardless of what you pick, the app always restricts results to
   emails that have a **PDF attachment**, so a single good filter is usually
   enough. Use **+ Add card** / the **×** button to add or remove rows, then click
   **Save settings** (you'll see a green ✓ Saved).

5. Click **Connect Gmail** and approve the read‑only access. You'll see an
   "unverified app" notice because the app is in Testing mode — that's expected;
   continue.
6. Click **Fetch / Refresh**. For each card the app finds the matching statement
   emails, decrypts and parses the PDFs, and renders the combined dashboard.

The **Activity log** at the bottom shows exactly what happened per card
(candidates found, statements kept, totals parsed, and any errors such as a
wrong password).

---

## Project structure

| File | Purpose |
|------|---------|
| `index.html` | UI layout + styling; loads the CDN libraries (Pyodide, Chart.js, Google Identity Services). |
| `app.js` | OAuth, Gmail search/fetch, Pyodide bootstrap, fetch orchestration, and all rendering. |
| `config.js` | `localStorage`‑backed settings (Client ID, cards, look‑back, count) and supported‑bank list. |
| `charts.js` | Chart.js dashboards + merchant → category helpers + INR formatting. |
| `py/pipeline.py` | Opens and text‑extracts PDFs with `pdfminer.six`; pulls the masked card last‑4. |
| `py/parsers.py` | Per‑bank parsers returning a normalized statement summary + transaction list. |

---

## Adding or tuning a bank parser

Statement layouts differ per bank, so each bank has its own logic in
`py/parsers.py`. The dedicated ICICI and HDFC parsers reconstruct the summary box
(total/minimum due, due date, billing period) and the multi‑page transaction
table; other banks fall back to a generic `date … merchant … amount` heuristic.

To add a new bank or improve accuracy, open a real statement as reference and
edit/add its parser in `py/parsers.py`. Keep the normalized shapes so the rest of
the app keeps working:

```python
# one transaction
{"date": "YYYY-MM-DD", "merchant": str, "amount": float,
 "type": "debit" | "credit", "card": label}

# statement summary
{"card": label, "bank": str, "totalDue": float | None,
 "minDue": float | None, "dueDate": "YYYY-MM-DD" | None,
 "statementPeriod": str | None}
```

The **How to** tab in the app contains a step‑by‑step guide (including how to use
an AI coding assistant against a sample statement) for adding new bank logic.

---

## Limitations

- Works on **text‑based** statement PDFs (the normal kind). Scanned/image‑only
  PDFs are not supported (no OCR in this build).
- The generic parser is a starting point; per‑bank tuning against your real
  statements gives the best accuracy.
- If a bank changes its statement template, its parser may need a quick update.

---

## Tech stack

- Vanilla HTML/CSS/JS — no build step, no framework.
- [Pyodide](https://pyodide.org/) (CPython in WebAssembly) +
  [`pdfminer.six`](https://github.com/pdfminer/pdfminer.six) for in‑browser PDF parsing.
- [Chart.js](https://www.chartjs.org/) for charts.
- [Google Identity Services](https://developers.google.com/identity) + Gmail API
  (read‑only) for fetching statements.
