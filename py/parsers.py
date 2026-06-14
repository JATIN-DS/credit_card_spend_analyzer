"""Per-bank statement parsers.

Design:
  - Every parser receives the `extracted` dict from pipeline.extract and returns
    the SAME normalized shape, so the charting layer is bank-agnostic.
  - A generic, heuristic line parser handles the common "date ... merchant ...
    amount" row layout and powers every bank by default.
  - Each bank has a thin override hook so you can tune column logic against your
    real statements without touching the others.

Normalized output:
  {
    "card": <label>,
    "bank": <BANK>,
    "transactions": [
        {"date": "YYYY-MM-DD", "merchant": str, "amount": float,
         "type": "debit"|"credit", "card": <label>}
    ],
    "summary": {"card", "bank", "totalDue", "minDue", "dueDate",
                "statementPeriod"},
    "error": None | str
  }
"""

import re
from datetime import datetime

# ---------------------------------------------------------------------------
# Regex building blocks
# ---------------------------------------------------------------------------

# amount like 1,234.56  or  1234.56  optionally followed by Cr/Dr
_AMOUNT_RE = re.compile(r"(\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})|\d+\.\d{1,2})")
_CR_RE = re.compile(r"\b(cr|credit)\b", re.IGNORECASE)

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}

# date forms: 12/05/2026, 12-05-26, 12 August 2026, June 5, 2026, 2026-05-12
_DATE_PATTERNS = [
    re.compile(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b"),
    re.compile(r"\b(\d{1,2})[ -]([A-Za-z]{3,9})[ -](\d{2,4})\b"),
    re.compile(r"\b([A-Za-z]{3,9})[ -](\d{1,2}),?[ -](\d{2,4})\b"),
    re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b"),
]


def _to_iso_date(s):
    """Best-effort parse of a date substring into YYYY-MM-DD; None if no match."""
    for pat in _DATE_PATTERNS:
        m = pat.search(s)
        if not m:
            continue
        g = m.groups()
        try:
            if pat is _DATE_PATTERNS[0]:  # d/m/y
                d, mo, y = int(g[0]), int(g[1]), _year(g[2])
            elif pat is _DATE_PATTERNS[1]:  # d Mon y
                d, mo, y = int(g[0]), _MONTHS.get(g[1].lower()[:3]), _year(g[2])
            elif pat is _DATE_PATTERNS[2]:  # Mon d y
                mo, d, y = _MONTHS.get(g[0].lower()[:3]), int(g[1]), _year(g[2])
            else:  # y-m-d
                y, mo, d = int(g[0]), int(g[1]), int(g[2])
            if not mo or not (1 <= mo <= 12) or not (1 <= d <= 31):
                continue
            return datetime(y, mo, d).strftime("%Y-%m-%d")
        except (ValueError, TypeError):
            continue
    return None


def _year(y):
    y = int(y)
    if y < 100:
        y += 2000
    return y


def _to_float(s):
    try:
        return float(s.replace(",", ""))
    except ValueError:
        return None


def _find_label_amount(full_text, labels):
    """Return the first amount that appears near any of the given labels."""
    lower = full_text.lower()
    for label in labels:
        idx = lower.find(label.lower())
        if idx == -1:
            continue
        window = full_text[idx: idx + len(label) + 40]
        m = _AMOUNT_RE.search(window[len(label):])
        if m:
            val = _to_float(m.group(1))
            if val is not None:
                return val
    return None


def _find_label_date(full_text, labels):
    lower = full_text.lower()
    for label in labels:
        idx = lower.find(label.lower())
        if idx == -1:
            continue
        window = full_text[idx: idx + len(label) + 40]
        iso = _to_iso_date(window[len(label):])
        if iso:
            return iso
    return None


# ---------------------------------------------------------------------------
# Generic heuristic parser (default for every bank)
# ---------------------------------------------------------------------------

def _generic_transactions(extracted, card_label):
    txns = []
    for page in extracted["pages"]:
        for line in page["lines"]:
            iso = _to_iso_date(line)
            if not iso:
                continue

            amounts = _AMOUNT_RE.findall(line)
            if not amounts:
                continue

            amount = _to_float(amounts[-1])
            if amount is None or amount == 0:
                continue

            # strip the date and the trailing amount to recover the merchant
            merchant = line
            for pat in _DATE_PATTERNS:
                merchant = pat.sub("", merchant, count=1)
            merchant = merchant.replace(amounts[-1], "")
            merchant = _CR_RE.sub("", merchant)
            merchant = re.sub(r"\b(dr|debit)\b", "", merchant, flags=re.IGNORECASE)
            merchant = re.sub(r"\s+", " ", merchant).strip(" .-|")

            if not merchant or len(merchant) < 2:
                continue

            txns.append(
                {
                    "date": iso,
                    "merchant": merchant,
                    "amount": amount,
                    "type": "credit" if _CR_RE.search(line) else "debit",
                    "card": card_label,
                }
            )
    return _dedupe(txns)


def _dedupe(txns):
    seen = set()
    out = []
    for t in txns:
        key = (t["date"], t["merchant"], t["amount"], t["type"])
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
    return out


def _generic_summary(extracted, bank, card_label):
    text = extracted["full_text"]
    return {
        "card": card_label,
        "bank": bank,
        "totalDue": _find_label_amount(
            text, ["Total Amount Due", "Total Dues", "Total Payment Due", "Closing Balance"]
        ),
        "minDue": _find_label_amount(
            text, ["Minimum Amount Due", "Minimum Payment Due", "Min Amount Due", "Min Due"]
        ),
        "dueDate": _find_label_date(
            text, ["Payment Due Date", "Due Date"]
        ),
        "statementPeriod": _find_label_date(
            text, ["Statement Date", "Statement Period", "Statement Generation Date"]
        ),
    }


def _generic_parse(bank, extracted, card_label):
    return {
        "card": card_label,
        "bank": bank,
        "transactions": _generic_transactions(extracted, card_label),
        "summary": _generic_summary(extracted, bank, card_label),
        "error": None,
    }


# ---------------------------------------------------------------------------
# Per-bank parsers
#
# Each starts by delegating to the generic parser. Once you share a real
# statement for a bank, replace the body with column-aware logic while keeping
# the same return shape.
# ---------------------------------------------------------------------------

# --- Flipkart Axis Bank credit card statement ------------------------------
# Layout (one row per transaction after y-reconstruction):
#   DATE  TRANSACTION DETAILS  MERCHANT CATEGORY  AMOUNT Dr|Cr  CASHBACK Dr|Cr
# The transaction amount is the FIRST "<number> Dr|Cr" on the row; the second
# one is the cashback column and is ignored.

_AXIS_DATE_RE = re.compile(r"^(\d{2}/\d{2}/\d{4})\b")
_AXIS_AMT_TYPE_RE = re.compile(r"([\d,]+\.\d{2})\s*(Dr|Cr)\b", re.IGNORECASE)

# Known merchant-category values seen on Axis/Flipkart statements. Used to peel
# the category column off the end of the details text. Longest matched first.
_AXIS_CATEGORIES = [
    "DEPARTMENT STORES", "DEPT STORES", "MISC STORE", "MISC STORES",
    "CLOTH STORES", "CLOTHING STORES", "GROCERY STORES", "GROCERIES", "GROCERY",
    "RESTAURANTS", "RESTAURANT", "HOTELS", "HOTEL", "AIRLINES", "RAILWAYS",
    "TRAVEL", "FUEL", "UTILITIES", "JEWELLERY", "AUTOMOBILES", "HEALTHCARE",
    "HEALTH", "PHARMACY", "ELECTRONICS", "ENTERTAINMENT", "INSURANCE",
    "EDUCATION", "TELECOM", "FINANCIAL SERVICES", "FINANCIAL", "SERVICES",
    "CASH WITHDRAWAL", "OTHERS", "MISC",
]


def _axis_split_merchant(middle):
    """Split 'details + category' into (merchant, category). Category may be
    glued to the details with no space, so we match it at the end of the text."""
    up = middle.upper()
    for cat in sorted(_AXIS_CATEGORIES, key=len, reverse=True):
        if up.endswith(cat):
            merchant = middle[: len(middle) - len(cat)].strip().rstrip(",").strip()
            return (merchant or middle), cat.title()
    return middle, None


def _axis_transactions(lines, card_label):
    txns = []
    for line in lines:
        m = _AXIS_DATE_RE.match(line)
        if not m:
            continue
        iso = _to_iso_date(m.group(1))
        if not iso:
            continue
        amts = list(_AXIS_AMT_TYPE_RE.finditer(line))
        if not amts:
            continue

        first = amts[0]  # transaction amount (cashback is the 2nd, ignored)
        amount = _to_float(first.group(1))
        if amount is None or amount == 0:
            continue
        ttype = "credit" if first.group(2).lower() == "cr" else "debit"

        middle = line[m.end(): first.start()].strip()
        merchant, category = _axis_split_merchant(middle)
        if not merchant:
            merchant = "UNKNOWN"

        txns.append(
            {
                "date": iso,
                "merchant": merchant,
                "amount": amount,
                "type": ttype,
                "card": card_label,
                "category": category,
            }
        )
    return _dedupe(txns)


def _axis_summary(lines, card_label):
    total = mindue = duedate = period = None
    for i, line in enumerate(lines):
        if "Total Payment Due" in line and "Minimum Payment Due" in line and i + 1 < len(lines):
            val = lines[i + 1]
            amts = _AMOUNT_RE.findall(val)
            if len(amts) >= 1:
                total = _to_float(amts[0])
            if len(amts) >= 2:
                mindue = _to_float(amts[1])
            dates = re.findall(r"\d{2}/\d{2}/\d{4}", val)
            if len(dates) >= 2:
                period = dates[0] + " - " + dates[1]
            if len(dates) >= 3:
                duedate = _to_iso_date(dates[2])
            break
    return {
        "card": card_label,
        "bank": "AXIS",
        "totalDue": total,
        "minDue": mindue,
        "dueDate": duedate,
        "statementPeriod": period,
    }


def parse_axis(extracted, card_label):
    lines = extracted.get("lines") or []
    if not lines:
        for page in extracted.get("pages", []):
            lines.extend(page.get("lines", []))
    txns = _axis_transactions(lines, card_label)
    # Fall back to the generic parser if the hard-coded layout matched nothing.
    if not txns:
        return _generic_parse("AXIS", extracted, card_label)
    return {
        "card": card_label,
        "bank": "AXIS",
        "transactions": txns,
        "summary": _axis_summary(lines, card_label),
        "error": None,
    }


# --- ICICI Bank credit card statements (all variants) ----------------------
# This parser targets the common ICICI Bank credit card statement structure and
# applies to every ICICI variant (Amazon Pay ICICI, Coral, Rubyx, etc.), since
# they share the same page-1 layout: a Date+SerNo transaction table, a gray dues
# box, a Statement Summary table, and white date boxes. Dispatch is by bank
# ("ICICI"), so all ICICI cards route here regardless of label.
#
# Transaction row (after y-reconstruction):
#   DATE  SERNO  TRANSACTION DETAILS  [REWARD PTS]  [INTL AMT]  AMOUNT [CR]
# Amounts have no Dr/Cr; a trailing "CR" marks a credit (refund/payment),
# otherwise it is a debit (purchase). The transaction amount is the last
# money token on the row; the serial number, reward points and intl amount
# columns are stripped off.

_MONEY_TOKEN_RE = re.compile(r"^[\d,]+\.\d{2}$")
# A transaction row in the ICICI table is uniquely identified by a DATE column
# immediately followed by a long numeric SerNo column. Requiring BOTH columns
# guarantees we only read the real transaction table (which has Date + SerNo)
# and never bleed into the Statement Summary / Credit Summary tables, which
# have no serial-number column. The pattern is searched ANYWHERE in the line so
# rows that got glued to a preceding sub-header (e.g. the masked card number
# "4315XXXXXXXX9015") are still recovered.
_ICICI_ROW_RE = re.compile(r"(\d{2}/\d{2}/\d{4})\s+(\d{6,})\b")


def _parse_icici_row(segment, card_label):
    """Parse a single Date+SerNo transaction row segment into a normalized txn."""
    m = _ICICI_ROW_RE.match(segment)
    if not m:
        return None
    iso = _to_iso_date(m.group(1))
    if not iso:
        return None

    # Everything after the SerNo is: Transaction Details [Reward Pts] [Intl Amt] Amount [CR]
    toks = segment[m.end():].split()
    if not toks:
        return None

    ttype = "debit"
    if toks[-1].upper() == "CR":
        ttype = "credit"
        toks = toks[:-1]
    if not toks or not _MONEY_TOKEN_RE.match(toks[-1]):
        return None

    amount = _to_float(toks[-1])  # rightmost money token = Amount (in Rs.)
    if amount is None or amount == 0:
        return None
    toks = toks[:-1]

    # Strip the trailing numeric columns (reward points, intl amount) that sit
    # between the transaction details and the amount.
    while toks and (toks[-1].replace(",", "").isdigit() or _MONEY_TOKEN_RE.match(toks[-1])):
        toks = toks[:-1]

    merchant = " ".join(toks).strip() or "UNKNOWN"
    return {
        "date": iso,
        "merchant": merchant,
        "amount": amount,
        "type": ttype,
        "card": card_label,
        "category": None,
    }


_MONEY_ANYWHERE_RE = re.compile(r"\d[\d,]*\.\d{2}")
# Lines that mark the end of the transaction table (so wrapped-row stitching
# never bleeds into a neighbouring table/footer).
_ICICI_TXN_BOUNDARIES = (
    "credit limit", "statement period", "international spends", "previous balance",
    "gst number", "spends overview", "reward points", "transaction details",
    "important messages", "page ",
)


def _icici_transactions(lines, card_label):
    """Parse the Date+SerNo transaction table, stitching wrapped rows.

    A row can be split across several lines because long merchant names wrap and
    the reward-points/amount land on their own line, e.g.:
        '23/04/2026 13290384133 AMAZON PAY IN E COMMERC BANGALORE'
        'IN'
        '88 1,779.13'
    When an anchor (Date+SerNo) line has no amount yet, we absorb following
    continuation lines until the amount appears (or the next anchor / a table
    boundary is reached). A single line can also hold multiple anchors (when the
    layout glued rows together), so each segment is parsed independently.
    """
    txns = []
    n = len(lines)
    i = 0
    while i < n:
        anchors = list(_ICICI_ROW_RE.finditer(lines[i]))
        if not anchors:
            i += 1
            continue

        segment_lines = [lines[i]]
        j = i + 1
        # Only look for continuation lines if the last anchor on this line
        # doesn't already carry its amount.
        last_seg = lines[i][anchors[-1].start():]
        need_amount = _MONEY_ANYWHERE_RE.search(last_seg) is None
        while need_amount and j < n and not _ICICI_ROW_RE.search(lines[j]):
            if any(b in lines[j].lower() for b in _ICICI_TXN_BOUNDARIES):
                break
            segment_lines.append(lines[j])
            if _MONEY_ANYWHERE_RE.search(lines[j]):
                j += 1
                break
            j += 1

        blob = " ".join(segment_lines)
        matches = list(_ICICI_ROW_RE.finditer(blob))
        for idx, mt in enumerate(matches):
            start = mt.start()
            end = matches[idx + 1].start() if idx + 1 < len(matches) else len(blob)
            row = _parse_icici_row(blob[start:end], card_label)
            if row:
                txns.append(row)

        i = max(j, i + 1)
    return _dedupe(txns)


# In real ICICI Bank credit card PDFs, the gray-box LABELS and their VALUES are
# emitted on separate, non-adjacent lines (the labels cluster together near the
# top, the two amounts appear later, just before "SPENDS OVERVIEW"), e.g.:
#     Total Amount due
#     Minimum Amount due
#     Interest will be charged if your
#     total amount due is not paid
#     ... EARNINGS / SPENDS percentages ...
#     `280.00            <- minimum
#     `5,554.13          <- total
#     SPENDS OVERVIEW
# So we cannot pair a label with an adjacent value. Instead we collect every
# money token in the region that starts at the dues labels and ends at the
# "SPENDS OVERVIEW"/"Statement period"/"Credit Limit" boundary, then assign by
# magnitude: Total Amount due >= Minimum Amount due, always.
_TOTAL_LABEL = "total amount due"
_MIN_LABEL = "minimum amount due"
_DUES_REGION_END = ("spends overview", "statement period", "credit limit", "credit summary")

# Tolerant money matcher: allows an optional Rs./INR/rupee-glyph prefix and even
# whitespace around the decimal point (e.g. "Rs.5,554 . 13"), which can happen
# when a large-font, letter-spaced gray-box value is split into fragments.
_LOOSE_AMOUNT_RE = re.compile(
    r"(?:\u20b9|rs\.?|inr)?\s*(\d{1,3}(?:,\d{2,3})*|\d+)\s*\.\s*(\d{2})\b",
    re.IGNORECASE,
)


def _loose_amount(text):
    m = _LOOSE_AMOUNT_RE.search(text)
    if not m:
        return None
    return _to_float(m.group(1) + "." + m.group(2))


def _first_amount(text):
    m = _AMOUNT_RE.search(text)
    return _to_float(m.group(1)) if m else None


def _all_amounts(text):
    return [
        _to_float(m.group(1) + "." + m.group(2))
        for m in _LOOSE_AMOUNT_RE.finditer(text)
    ]


def _icici_gray_box_dues(lines):
    """Total / Minimum Amount due from the gray box region on page 1.

    Finds the dues label block, then gathers every money token until the
    region boundary and assigns by magnitude (total >= minimum). Returns
    (total, minimum); either may be None.
    """
    n = len(lines)
    start = next((i for i, l in enumerate(lines) if _MIN_LABEL in l.lower()), None)
    if start is None:
        start = next((i for i, l in enumerate(lines) if _TOTAL_LABEL in l.lower()), None)
    if start is None:
        return None, None

    end = n
    for j in range(start + 1, n):
        low = lines[j].lower()
        # Stop at a section boundary or at the start of the transaction table
        # (a Date+SerNo anchor) so we never pick up transaction amounts.
        if any(b in low for b in _DUES_REGION_END) or _ICICI_ROW_RE.search(lines[j]):
            end = j
            break

    amounts = []
    for k in range(start + 1, end):
        # skip the fine-print sentence that repeats the label text
        if "interest will be charged" in lines[k].lower():
            continue
        amounts.extend(a for a in _all_amounts(lines[k]) if a is not None)

    if not amounts:
        return None, None
    if len(amounts) == 1:
        return amounts[0], None
    return max(amounts), min(amounts)


# --- Primary: Total Amount due from the Statement Summary table --------------
# The statement defines (shown as "+  +  -  =" in the gray box):
#     Total Amount due = Previous Balance (-/+ if CR) + Purchases/Charges
#                        + Cash Advances - Payments/Credits
# The four COLUMN LABELS sit on one reconstructed line and their four VALUES on
# the next, column-aligned, e.g.:
#     Previous Balance Purchases / Charges Cash Advances Payments / Credits
#     `1,788.82 CR     `7,342.95           `0.00         `0.00
# This is order-independent (only needs the header line + its value line), so it
# does not depend on where the gray box happens to land after reconstruction.
def _icici_total_from_summary(lines):
    n = len(lines)
    for i, line in enumerate(lines):
        low = line.lower()
        if not ("previous balance" in low and ("purchase" in low or "charges" in low)):
            continue
        # Values are on this same line (if glued) or the next few lines.
        value_line = None
        if len(list(_LOOSE_AMOUNT_RE.finditer(line))) >= 2:
            value_line = line[low.find("previous balance"):]
        else:
            for j in range(i + 1, min(i + 4, n)):
                if len(list(_LOOSE_AMOUNT_RE.finditer(lines[j]))) >= 2:
                    value_line = lines[j]
                    break
        if not value_line:
            continue

        matches = list(_LOOSE_AMOUNT_RE.finditer(value_line))
        vals = [_to_float(m.group(1) + "." + m.group(2)) for m in matches]
        prev = vals[0]
        # "CR" right after the previous-balance value means a credit balance.
        after = value_line[matches[0].end(): matches[0].end() + 6].lower()
        if re.search(r"\bcr\b", after):
            prev = -prev
        purchases = vals[1] if len(vals) > 1 else 0.0
        cash = vals[2] if len(vals) > 2 else 0.0
        payments = vals[3] if len(vals) > 3 else 0.0
        return round(prev + purchases + cash - payments, 2)
    return None


# Min due lives only in the gray box (no formula). Find it among the
# "amount-only" lines on page 1 (lines that are nothing but one or two money
# tokens) which, apart from the credit-limit/summary value rows (4 tokens), are
# unique to the gray box dues.
def _amount_only_values(lines):
    out = []
    for line in lines:
        amts = _all_amounts(line)
        if not amts:
            continue
        stripped = _LOOSE_AMOUNT_RE.sub("", line)
        stripped = re.sub(r"[`\u20b9,\s.cr]", "", stripped, flags=re.IGNORECASE)
        if stripped == "" and len(amts) <= 2:  # excludes 4-value limit/summary rows
            out.extend(a for a in amts if a is not None)
    return out


# "Month D, YYYY" dates as used by the white date boxes and the period line.
_NAMED_DATE_RE = re.compile(r"\b([A-Za-z]{3,9})[ -](\d{1,2}),?[ -](\d{2,4})\b")


def _named_dates(s):
    out = []
    for m in _NAMED_DATE_RE.finditer(s):
        mo = _MONTHS.get(m.group(1).lower()[:3])
        if not mo:
            continue
        try:
            d, y = int(m.group(2)), _year(m.group(3))
            if 1 <= d <= 31:
                out.append(datetime(y, mo, d).strftime("%Y-%m-%d"))
        except (ValueError, TypeError):
            continue
    return out


def _icici_due_date(lines):
    """Payment Due Date = the latest 'Month D, YYYY' date on page 1.

    Labels and values are detached in the PDF, but the due date is always the
    farthest-future named date on page 1 (after the statement date and the
    statement-period dates). Transaction dates use dd/mm/yyyy, so they don't
    interfere with this month-name match.
    """
    best = None
    for line in lines:
        for iso in _named_dates(line):
            if best is None or iso > best:
                best = iso
    return best


def _icici_period(lines):
    """Statement period taken straight from the explicit 'Statement period' line."""
    for line in lines:
        m = re.search(
            r"statement period\s*:?\s*(.+?\bto\b\s+[A-Za-z]{3,9}[ -]\d{1,2},?\s*\d{2,4})",
            line,
            re.IGNORECASE,
        )
        if m:
            return re.sub(r"\s+", " ", m.group(1)).strip()
    return None


def _icici_summary(page1_lines, card_label):
    # The gray box (dues), white date boxes and the statement-period line only
    # ever appear on PAGE 1 of an ICICI Bank credit card statement. Restricting the
    # scan to page 1 prevents look-alike tables on later pages from hijacking
    # these values.
    region_total, region_min = _icici_gray_box_dues(page1_lines)

    # Total Amount due: prefer the order-independent Statement Summary arithmetic.
    total = _icici_total_from_summary(page1_lines)
    if total is None:
        total = region_total

    # Minimum Amount due: gray-box region first, then the smallest amount-only
    # value that isn't the total.
    mindue = region_min
    if mindue is None:
        singles = [v for v in _amount_only_values(page1_lines) if total is None or abs(v - total) > 0.001]
        if singles:
            mindue = min(singles)

    # Total must be >= minimum; swap if the heuristics came out inverted.
    if total is not None and mindue is not None and mindue > total:
        total, mindue = mindue, total

    return {
        "card": card_label,
        "bank": "ICICI",
        "totalDue": total,
        "minDue": mindue,
        "dueDate": _icici_due_date(page1_lines),
        "statementPeriod": _icici_period(page1_lines),
    }


def parse_icici(extracted, card_label):
    pages = extracted.get("pages", [])
    # Transactions can run across multiple pages, so scan the flat line list.
    all_lines = extracted.get("lines") or []
    if not all_lines:
        for page in pages:
            all_lines.extend(page.get("lines", []))
    # Summary fields (dues + dates) are read from PAGE 1 ONLY.
    page1_lines = pages[0].get("lines", []) if pages else all_lines

    txns = _icici_transactions(all_lines, card_label)
    if not txns:
        return _generic_parse("ICICI", extracted, card_label)
    return {
        "card": card_label,
        "bank": "ICICI",
        "transactions": txns,
        "summary": _icici_summary(page1_lines, card_label),
        "error": None,
    }


# --- HDFC Bank credit card statements --------------------------------------
# Layout (from a real HDFC Bank credit card statement):
#   Top block (simple label : value rows on page 1):
#       Statement Date    19 May, 2026
#       Billing Period    20 Apr, 2026 - 19 May, 2026
#   Summary box (column header row + value row, plus a separate TOTAL box):
#       PREVIOUS STATEMENT DUES | PAYMENTS/CREDITS RECEIVED |
#       PURCHASES/DEBIT | FINANCE CHARGES                      TOTAL AMOUNT DUE
#       `2,174.80  `3,424.30  `4,071.43  `0.00                 `2,822.00
#       MINIMUM DUE   DUE DATE
#       `200.00       08 Jun, 2026
#   Transaction table ("Domestic Transactions", can span multiple pages):
#       DATE & TIME            TRANSACTION DESCRIPTION        AMOUNT   PI
#       22/04/2026| 17:47      SwiggyBANGALORE                `426.00  *
#       22/04/2026| 00:00      Razorpay PaymentsBANGALORE   + `417.00
# Credits (payments / cashback / reversals into the card) are prefixed with a
# "+" (and shown in green); debits carry no sign. A trailing "Cr" is also
# treated as a credit for robustness.

# A transaction row starts with dd/mm/yyyy, optionally followed by "| HH:MM".
# Statement/period/due dates use the "DD Mon, YYYY" form, so the dd/mm/yyyy
# anchor only ever matches real transaction rows.
_HDFC_ROW_RE = re.compile(r"^\s*(\d{2}/\d{2}/\d{4})\s*\|?\s*(\d{1,2}:\d{2})?\s*")
# "DD Mon, YYYY" / "DD Mon YYYY" as used by HDFC for the dated header fields.
_HDFC_NAMED_DATE_RE = re.compile(r"\b(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{2,4})\b")
# Currency / sign noise to peel off a merchant string.
_HDFC_NOISE_RE = re.compile(r"[+\u20b9`]")


def _hdfc_named_iso(day, mon_name, year):
    mo = _MONTHS.get(mon_name.lower()[:3])
    if not mo:
        return None
    try:
        d, y = int(day), _year(year)
        if 1 <= d <= 31:
            return datetime(y, mo, d).strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return None
    return None


def _hdfc_named_dates(s):
    """All 'DD Mon, YYYY' dates in a string as (iso, raw) pairs, in order."""
    out = []
    for m in _HDFC_NAMED_DATE_RE.finditer(s):
        iso = _hdfc_named_iso(m.group(1), m.group(2), m.group(3))
        if iso:
            out.append((iso, m.group(0).strip()))
    return out


def _hdfc_transactions(lines, card_label):
    txns = []
    for line in lines:
        m = _HDFC_ROW_RE.match(line)
        if not m:
            continue
        iso = _to_iso_date(m.group(1))
        if not iso:
            continue
        rest = line[m.end():]
        amts = list(_AMOUNT_RE.finditer(rest))
        if not amts:
            continue
        last = amts[-1]
        amount = _to_float(last.group(1))
        if amount is None or amount == 0:
            continue

        # Credit when a "+" sits just before the amount (HDFC marks payments,
        # cashback and refunds with a leading +) or a trailing "Cr" follows.
        pre = rest[max(0, last.start() - 5): last.start()]
        post = rest[last.end(): last.end() + 4]
        ttype = "credit" if ("+" in pre or re.search(r"\bcr\b", post, re.IGNORECASE)) else "debit"

        merchant = _HDFC_NOISE_RE.sub(" ", rest[:last.start()])
        merchant = re.sub(r"\s+", " ", merchant).strip(" .,-|")
        if not merchant:
            merchant = "UNKNOWN"

        txns.append(
            {
                "date": iso,
                "merchant": merchant,
                "amount": amount,
                "type": ttype,
                "card": card_label,
                "category": None,
            }
        )
    return _dedupe(txns)


def _hdfc_amount_after(lines, label_subs, max_ahead=4):
    """First money amount at/after a label (same line, then the next lines).

    Used for the directly-printed Total/Minimum due. find() picks the FIRST
    occurrence of the label, which is the summary box (the legal fine-print that
    repeats 'minimum amount due' appears lower in the document)."""
    for i, line in enumerate(lines):
        low = line.lower()
        for sub in label_subs:
            k = low.find(sub)
            if k == -1:
                continue
            tail = line[k + len(sub):]
            a = _loose_amount(tail)
            if a is not None:
                return a
            for j in range(i + 1, min(i + 1 + max_ahead, len(lines))):
                a = _loose_amount(lines[j])
                if a is not None:
                    return a
    return None


def _hdfc_total(lines):
    """Total Amount Due for HDFC, robust to the summary-box layout.

    HDFC prints the summary as:  Previous Statement Dues - Payments/Credits
    Received + Purchases/Debit + Finance Charges = TOTAL AMOUNT DUE. After
    y-reconstruction the four component values (and often the total itself) land
    on one column-aligned line, e.g.
        `2,174.80  `3,424.30  `4,071.43  `0.00  `2,822.00
    Picking the "amount after the Total label" is unreliable (it grabs the first
    component). Instead we:
      1. find the summary block (anchored on "previous statement dues"),
      2. compute the expected total via the box arithmetic from the first four
         values, then
      3. return the PRINTED amount in the block that's closest to that expected
         value (so it matches the statement exactly, e.g. `2,822.00 vs an
         arithmetic 2,821.93). Falls back to the arithmetic value, then to the
         directly-labelled amount.
    """
    n = len(lines)
    start = None
    for i, line in enumerate(lines):
        low = line.lower()
        if "previous statement dues" in low or ("previous" in low and "dues" in low):
            start = i
            break
    if start is None:
        return _hdfc_amount_after(lines, ["total amount due"])

    region = []          # every money token in the summary block
    components = None     # the first 4 column-aligned values
    for j in range(start, min(start + 10, n)):
        amts = [v for v in _all_amounts(lines[j]) if v is not None]
        region.extend(amts)
        if components is None and len(amts) >= 3:
            components = amts
    if not components:
        return _hdfc_amount_after(lines, ["total amount due"])

    prev, pay, pur = components[0], components[1], components[2]
    fin = components[3] if len(components) > 3 else 0.0
    arith = round(prev - pay + pur + fin, 2)

    # The printed total is whichever amount in the block is closest to the
    # arithmetic value (handles the bank's rupee rounding of the total).
    tol = max(1.0, abs(arith) * 0.01)
    best, best_d = None, None
    for a in region:
        d = abs(a - arith)
        if best is None or d < best_d:
            best, best_d = a, d
    if best is not None and best_d <= tol:
        return best
    return arith


def _hdfc_period(lines):
    """Billing/Statement period as a clean 'DD Mon YYYY - DD Mon YYYY' string."""
    for line in lines:
        low = line.lower()
        if "billing period" in low or "statement period" in low:
            dates = _hdfc_named_dates(line)
            if len(dates) >= 2:
                return dates[0][1] + " - " + dates[1][1]
    # Fallback: any line holding two named dates joined by a dash.
    for line in lines:
        if "-" not in line and "\u2013" not in line:
            continue
        dates = _hdfc_named_dates(line)
        if len(dates) >= 2:
            return dates[0][1] + " - " + dates[1][1]
    return None


def _hdfc_due_date(lines):
    """Payment due date = the farthest-future 'DD Mon, YYYY' date on page 1.

    The due date (08 Jun) always falls after the statement date and the billing
    period close (both 19 May), so the latest named date is the due date."""
    best = None
    for line in lines:
        for iso, _ in _hdfc_named_dates(line):
            if best is None or iso > best:
                best = iso
    return best


def _hdfc_summary(page1_lines, card_label):
    # Total Amount Due via the summary-block arithmetic anchor (matches the
    # printed value even when all five amounts share one reconstructed line).
    total = _hdfc_total(page1_lines)

    mindue = _hdfc_amount_after(page1_lines, ["minimum due", "minimum amount due", "min amount due"])
    if total is not None and mindue is not None and mindue > total:
        total, mindue = mindue, total

    return {
        "card": card_label,
        "bank": "HDFC",
        "totalDue": total,
        "minDue": mindue,
        "dueDate": _hdfc_due_date(page1_lines),
        "statementPeriod": _hdfc_period(page1_lines),
    }


def parse_hdfc(extracted, card_label):
    pages = extracted.get("pages", [])
    # Transactions can span multiple pages → scan the flat line list.
    all_lines = extracted.get("lines") or []
    if not all_lines:
        for page in pages:
            all_lines.extend(page.get("lines", []))
    # Summary fields (dues + dates) live on PAGE 1 only.
    page1_lines = pages[0].get("lines", []) if pages else all_lines

    txns = _hdfc_transactions(all_lines, card_label)
    if not txns:
        return _generic_parse("HDFC", extracted, card_label)
    return {
        "card": card_label,
        "bank": "HDFC",
        "transactions": txns,
        "summary": _hdfc_summary(page1_lines, card_label),
        "error": None,
    }


def parse_sbi(extracted, card_label):
    return _generic_parse("SBI", extracted, card_label)


def parse_amex(extracted, card_label):
    return _generic_parse("AMEX", extracted, card_label)


_REGISTRY = {
    "HDFC": parse_hdfc,
    "AXIS": parse_axis,
    "ICICI": parse_icici,
    "SBI": parse_sbi,
    "AMEX": parse_amex,
}


def parse_statement(bank, extracted, card_label):
    parser = _REGISTRY.get((bank or "").upper(), None)
    if parser is None:
        return _generic_parse(bank or "UNKNOWN", extracted, card_label)
    return parser(extracted, card_label)
