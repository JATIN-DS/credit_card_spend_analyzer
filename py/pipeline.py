"""PDF extraction pipeline that runs inside the browser via Pyodide.

Uses pdfminer.six (pure Python, Pyodide-compatible) to open a possibly
password-protected statement PDF. Critically, instead of pdfminer's default
reading-order text (which scrambles table cells), we reconstruct each visual
row by grouping text fragments that share the same vertical position (y) and
sorting them left-to-right (x). This turns tabular statements back into clean,
one-line-per-row text that the bank parsers can reliably parse.
"""

import io
import json
import re

from pdfminer.high_level import extract_pages
from pdfminer.layout import LTTextContainer, LTTextLine
from pdfminer.pdfdocument import PDFPasswordIncorrect


def _reconstruct_lines(page_layout, y_tol=3):
    """Rebuild visual rows from a pdfminer page layout.

    Fragments whose vertical positions are within `y_tol` points are treated as
    the same row and joined left-to-right by their x position.
    """
    items = []
    for element in page_layout:
        if isinstance(element, LTTextContainer):
            for line in element:
                if isinstance(line, LTTextLine):
                    text = line.get_text().strip()
                    if text:
                        x0, y0, x1, y1 = line.bbox
                        items.append((y0, x0, text))

    rows = []  # each: [y, [(x, text), ...]]
    for y0, x0, text in items:
        placed = False
        for row in rows:
            if abs(row[0] - y0) <= y_tol:
                row[1].append((x0, text))
                placed = True
                break
        if not placed:
            rows.append([y0, [(x0, text)]])

    rows.sort(key=lambda r: -r[0])  # top of page first
    lines = []
    for row in rows:
        row[1].sort(key=lambda p: p[0])
        lines.append(" ".join(p[1] for p in row[1]))
    return lines


def extract(pdf_bytes, password):
    """Open a PDF and return reconstructed per-page rows.

    Returns a dict with:
      - pages: list of {text, lines, tables}
      - lines: all rows across pages (flat list)
      - full_text: all rows joined by newlines
      - error: a string when the PDF could not be opened (e.g. bad password)
    """
    pwd = password if password else ""
    pages = []
    all_lines = []

    try:
        for page_layout in extract_pages(io.BytesIO(bytes(pdf_bytes)), password=pwd):
            lines = _reconstruct_lines(page_layout)
            pages.append({"text": "\n".join(lines), "lines": lines, "tables": []})
            all_lines.extend(lines)
    except PDFPasswordIncorrect:
        return {"pages": [], "lines": [], "full_text": "", "error": "WRONG_PASSWORD"}
    except Exception as exc:
        msg = str(exc).lower()
        if "password" in msg or "decrypt" in msg or "encrypt" in msg:
            return {"pages": [], "lines": [], "full_text": "", "error": "WRONG_PASSWORD"}
        return {"pages": [], "lines": [], "full_text": "", "error": "OPEN_FAILED: " + str(exc)}

    return {
        "pages": pages,
        "lines": all_lines,
        "full_text": "\n".join(all_lines),
        "error": None,
    }


# A masked credit-card number: four groups of 4 chars (digits or X/x/*/bullet
# masks), separators optional, ending in 4 real digits. We require at least one
# mask char so we don't grab plain 16-digit reference/transaction numbers.
_PAN_GROUPED_RE = re.compile(
    r"(?<![0-9])"
    r"([0-9Xx\*\u2022\u25cf\#]{4}[ \-]?[0-9Xx\*\u2022\u25cf\#]{4}[ \-]?"
    r"[0-9Xx\*\u2022\u25cf\#]{4}[ \-]?([0-9]{4}))"
    r"(?![0-9])"
)
# Contiguous masked PAN with no separators, e.g. XXXXXXXXXXXX1234.
_PAN_CONTIG_RE = re.compile(
    r"(?<![0-9])([0-9Xx\*\u2022\u25cf\#]{8,15}([0-9]{4}))(?![0-9])"
)
_MASK_RE = re.compile(r"[Xx\*\u2022\u25cf\#]")
_ENDING_RE = re.compile(r"ending(?:\s+(?:in|with))?\s*[:#\-]?\s*(\d{4})\b", re.IGNORECASE)


def extract_card_last4(text):
    """Best-effort extraction of a card's last 4 digits from statement text.

    Looks for a masked PAN (e.g. ``XXXX XXXX XXXX 1234`` / ``4375XXXXXXXX1234``)
    and falls back to phrases like ``ending in 1234``. Returns a 4-char string or
    ``None``. The mask requirement avoids matching unrelated 16-digit numbers.
    """
    if not text:
        return None
    for rex in (_PAN_GROUPED_RE, _PAN_CONTIG_RE):
        for m in rex.finditer(text):
            token, last4 = m.group(1), m.group(2)
            if _MASK_RE.search(token):
                return last4
    m = _ENDING_RE.search(text)
    if m:
        return m.group(1)
    return None


def process_pdf(pdf_bytes, password, bank, card_label):
    """Top-level entry called from JavaScript.

    Extracts the PDF then dispatches to the bank parser. Always returns a JSON
    string so the JS side has a single, predictable contract. Includes
    `raw_text` so the UI can show the extracted text for debugging/tuning.
    """
    import parsers  # imported here so a parser edit can be reloaded independently

    extracted = extract(pdf_bytes, password)
    if extracted["error"]:
        return json.dumps(
            {
                "card": card_label,
                "bank": bank,
                "transactions": [],
                "summary": None,
                "error": extracted["error"],
                "raw_text": "",
            }
        )

    try:
        result = parsers.parse_statement(bank, extracted, card_label)
    except Exception as exc:
        result = {
            "card": card_label,
            "bank": bank,
            "transactions": [],
            "summary": None,
            "error": "PARSE_FAILED: " + str(exc),
        }

    # Card number is almost always printed on page 1; scope the search there
    # first (more reliable), then fall back to the whole document.
    page1 = extracted["pages"][0]["text"] if extracted.get("pages") else ""
    last4 = extract_card_last4(page1) or extract_card_last4(extracted["full_text"])
    result["cardLast4"] = last4
    if isinstance(result.get("summary"), dict):
        result["summary"]["cardLast4"] = last4

    result["raw_text"] = extracted["full_text"]
    return json.dumps(result)
