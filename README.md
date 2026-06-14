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

## ▶️ Open the app

### Option 1 — Hosted (recommended, nothing to install)

Just open and bookmark this permanent link:

### 👉 **https://jatin-ds.github.io/credit_card_spend_analyzer/**

No terminal, no download, no local server — it works from any browser, on any
computer, and your settings stay saved in that browser. Do the **one‑time Google
OAuth setup** ([Part 1](#part-1--create-a-google-oauth-client-id-free-5-min-no-billing))
once, making sure to add `https://jatin-ds.github.io` as an Authorized JavaScript
origin on your Client ID.

### Option 2 — Run locally / offline

Prefer to run it on your own machine? See
**[Part 2 — Run locally](#part-2--run-locally-option-2)**.

> **Does this link work only for me?** The page is public, but it stores **no
> data and no Client ID** — everything lives only in *your* browser's
> `localStorage`. So it works for you because your browser already has your
> Client ID + cards saved. **Any new user** can open the same link and use it
> too, but they must enter **their own** Google OAuth Client ID (see Part 1) —
> the app then reads *their* Gmail. Two people never share data or credentials.

---

## 🗺️ How to use it — at a glance

In plain words, you do this **once**: get a free "key" from Google (the Client
ID) so the app is allowed to read your Gmail, paste it into the app, add your
cards and their PDF passwords, and connect Gmail. After that, **every month you
just open the link and click Fetch** — no passwords to type again.

```mermaid
flowchart TD
    A([Start]) --> B{First time<br/>using this app?}

    B -- "Yes" --> C["<b>1. Get your Google key</b><br/>Create a Google OAuth Client ID<br/>(Part 1 below · ~5 min · free)"]
    C --> D["<b>2. Open the app</b><br/>jatin-ds.github.io/credit_card_spend_analyzer"]
    D --> E["<b>3. Set it up once</b><br/>Settings → paste Client ID,<br/>add cards + PDF passwords → Save"]
    E --> F["<b>4. Connect Gmail</b><br/>click 'Connect Gmail' and<br/>approve read-only access"]

    B -- "No, I'm back" --> R["Open the app link<br/>(your settings are still saved)"]
    R --> F

    F --> G{"Sign-in blocked?<br/>'Error 400: origin_mismatch'"}
    G -- "Yes" --> H["Add https://jatin-ds.github.io as an<br/>Authorized JavaScript origin in the<br/>Google Console, then wait 1-2 min<br/>(see Troubleshooting)"]
    H --> F
    G -- "No" --> I["<b>5. Click 'Fetch / Refresh'</b>"]

    I --> J([📊 See your combined<br/>spending dashboard])

    classDef start fill:#4ADE80,stroke:#16a34a,color:#06210f;
    classDef done fill:#6C63FF,stroke:#4f46e5,color:#fff;
    classDef warn fill:#FBBF24,stroke:#b45309,color:#3a2a04;
    class A start;
    class J done;
    class H warn;
```

> Steps 1–3 happen **only the first time**. From then on, returning is just:
> **open the link → Connect Gmail → Fetch**.

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

The only one‑time setup is creating a Google OAuth Client ID so the app can read
*your* Gmail with your permission. The in‑app **How to** tab walks through the
same steps if you prefer to follow along in the UI.

### Part 1 — Create a Google OAuth Client ID (free, ~5 min, no billing)

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
5. **Create the credential**: open
   **<https://console.cloud.google.com/apis/credentials>** → **Create
   Credentials → OAuth client ID**
   - Application type: **Web application**
   - **Authorized JavaScript origins** → click **Add URI** → add
     `https://jatin-ds.github.io` (for the hosted app). If you'll also run it
     locally, **Add URI** again with `http://localhost:8000`.
   - **Create**, then copy the **Client ID** (looks like
     `1234567890-abcd.apps.googleusercontent.com`). No client secret is needed.
6. Open the app, go to **Settings**, paste the Client ID, and **Save settings**.

> None of these steps ask for a credit card. Billing is only required for paid
> Google Cloud products, which this app does not use.

#### 🔑 Already created your Client ID? Find it again

You don't create a new one each time. To copy your existing Client ID later:

1. Open **<https://console.cloud.google.com/apis/credentials>** (sign in with the
   same Google account; pick the right project in the top‑bar dropdown).
2. Under **OAuth 2.0 Client IDs**, click your client's name.
3. Copy the **Client ID** shown on the right → paste it into the app's
   **Settings**.

### Part 2 — Run locally (Option 2)

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

## Troubleshooting

### "Access blocked: Authorization Error" / `Error 400: origin_mismatch`

This means the URL you opened the app from isn't listed as an **Authorized
JavaScript origin** on your Client ID. Fix it once:

1. Open **<https://console.cloud.google.com/apis/credentials>** and select the
   project that owns your Client ID.
2. Under **OAuth 2.0 Client IDs**, click your client's name to edit it.
3. Under **Authorized JavaScript origins** → **Add URI**, add the **exact**
   origin (scheme + host, **no path, no trailing slash**):
   - Hosted app: `https://jatin-ds.github.io`
   - Local use: `http://localhost:8000`
4. **Save**, wait ~1–2 minutes, then hard‑refresh the app (Cmd/Ctrl+Shift+R) and
   click **Connect Gmail** again.

> Make sure you edit the **same** Client ID that's saved in the app's Settings,
> and that you put the value under *JavaScript origins* — not *redirect URIs*.

### "This app isn't verified" / Access blocked for a test user

Your Gmail address must be listed as a **Test user** on the consent screen
(*APIs & Services → OAuth consent screen → Test users*). Add it, then retry.

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
