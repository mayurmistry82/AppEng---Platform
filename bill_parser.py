"""
Energy bill parser (Australia) using Claude Vision.

Given a bill file path (PDF or image), this module sends the pages/images to
Anthropic's Claude and returns a structured Python dictionary suitable for
solar + battery sizing.
"""

from __future__ import annotations

import base64
import datetime as _dt
import json
import os
from pathlib import Path
from typing import Any

import anthropic


# -----------------------------
# Core parsing / normalization
# -----------------------------

def _coerce_int(value: Any) -> int | None:
    """Best-effort conversion to int (returns None if not possible)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if value.is_integer():
            return int(value)
        return None
    if isinstance(value, str):
        s = value.strip().replace(",", "")
        if not s:
            return None
        try:
            return int(float(s))
        except ValueError:
            return None
    return None


def _coerce_float(value: Any) -> float | None:
    """Best-effort conversion to float (returns None if not possible)."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        # Remove common currency / unit clutter (AUD, $, c/kWh, kWh).
        s = (
            s.replace("AUD", "")
            .replace("A$", "")
            .replace("$", "")
            .replace("c/kWh", "")
            .replace("¢/kWh", "")
            .replace("kWh", "")
            .strip()
        )
        # Handle comma thousands separators.
        s = s.replace(",", "")
        try:
            return float(s)
        except ValueError:
            return None
    return None


def _coerce_bool(value: Any) -> bool | None:
    """Best-effort conversion to bool (returns None if not possible)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        s = value.strip().lower()
        if s in {"true", "yes", "y", "1"}:
            return True
        if s in {"false", "no", "n", "0"}:
            return False
    return None


def _coerce_str(value: Any) -> str | None:
    """Best-effort conversion to non-empty string (returns None if not possible)."""
    if not isinstance(value, str):
        return None
    s = value.strip()
    return s or None


def _coerce_date_iso(value: Any) -> str | None:
    """
    Best-effort conversion to ISO date string (YYYY-MM-DD).

    If parsing fails, returns the original trimmed string (to preserve information)
    rather than dropping it entirely.
    """
    s = _coerce_str(value)
    if s is None:
        return None
    candidates = [
        "%Y-%m-%d",
        "%d/%m/%Y",
        "%d-%m-%Y",
        "%d %b %Y",
        "%d %B %Y",
        "%b %d %Y",
        "%B %d %Y",
    ]
    for fmt in candidates:
        try:
            return _dt.datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return s


def _coerce_historical_usage(value: Any) -> list[dict[str, Any]] | None:
    """
    Coerce historical usage list to a list of dicts:
      - period_label: str|None
      - kwh: float|None
      - days: int|None
    """
    if value is None:
        return None
    if not isinstance(value, list):
        return None
    out: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        period_label = _coerce_str(item.get("period_label"))
        kwh = _coerce_float(item.get("kwh"))
        days = _coerce_int(item.get("days"))
        if period_label is None and kwh is None and days is None:
            continue
        out.append({"period_label": period_label, "kwh": kwh, "days": days})
    return out or None


def _extract_json_from_text(text: str) -> dict[str, Any]:
    """
    Parse a JSON object from Claude output.

    Claude is instructed to output pure JSON, but this is defensive in case it
    wraps the JSON with extra text.
    """
    text = text.strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    # Fallback: pull the first {...} block.
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidate = text[start : end + 1]
        parsed2 = json.loads(candidate)
        if isinstance(parsed2, dict):
            return parsed2

    raise ValueError("Claude response did not contain a valid JSON object.")


# -----------------------------
# Input handling (image/PDF)
# -----------------------------

def _encode_image_bytes(image_bytes: bytes) -> str:
    return base64.b64encode(image_bytes).decode("utf-8")


def _pdf_to_png_pages(pdf_path: Path) -> list[bytes]:
    """
    Convert each PDF page to a PNG image (bytes) using PyMuPDF.

    Raises a clear error if PyMuPDF isn't installed.
    """
    try:
        import fitz  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(
            "PyMuPDF is required for PDF parsing. Install it with: pip install pymupdf"
        ) from exc

    doc = fitz.open(pdf_path)  # noqa: SLF001 (third-party API)
    pages: list[bytes] = []
    try:
        # Render at ~150 DPI for a good accuracy/size tradeoff.
        zoom = 150 / 72
        matrix = fitz.Matrix(zoom, zoom)  # noqa: SLF001
        for page in doc:
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            pages.append(pix.tobytes("png"))
    finally:
        doc.close()

    if not pages:
        raise ValueError("PDF contained no pages.")
    return pages


# -----------------------------
# Claude Vision API invocation
# -----------------------------

def parse_bill(file_path: str) -> dict[str, Any]:
    """
    Parse an Australian electricity bill (PDF or image) into structured fields.

    Returns a dictionary with keys:
      - billing_period_days: number of days in this billing period
      - billing_period_start: start date of billing period (ISO if possible)
      - billing_period_end: end date of billing period (ISO if possible)
      - total_kwh: total kWh consumed this billing period
      - daily_avg_kwh: average daily consumption in kWh
      - tariff_rate: electricity rate in dollars per kWh (first tier if multiple)
      - feed_in_tariff: feed-in tariff rate in dollars per kWh (0 if not present)
      - annual_spend: total annual electricity cost in AUD (extrapolated if needed)
      - retailer: name of the electricity retailer
      - plan_name: name of the electricity plan
      - historical_usage: list of previous billing periods in the bill:
            [{period_label, kwh, days}, ...]
      - has_solar: boolean (true if solar export data is present)
    """
    # Load and validate the file path.
    path = Path(file_path)
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f"Bill file not found: {file_path}")

    suffix = path.suffix.lower()
    image_media_type = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }.get(suffix)

    image_blocks: list[dict[str, Any]] = []

    if suffix == ".pdf":
        # Convert each PDF page to PNG and include all pages.
        for page_png in _pdf_to_png_pages(path):
            image_blocks.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": _encode_image_bytes(page_png),
                    },
                }
            )
    elif image_media_type is not None:
        image_blocks.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image_media_type,
                    "data": _encode_image_bytes(path.read_bytes()),
                },
            }
        )
    else:
        raise ValueError(
            f"Unsupported file type: {suffix} (use pdf/jpg/jpeg/png/webp)."
        )

    # Create the Anthropic client (expects ANTHROPIC_API_KEY in env).
    # You can also pass api_key=... explicitly if you prefer.
    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

    # Prompt: force a single JSON object with specific keys and units.
    prompt = (
        "You are extracting structured data from an Australian electricity bill (PDF pages or images).\n"
        "Return ONLY a single JSON object (no markdown, no backticks, no extra text) with exactly these keys:\n"
        "  billing_period_days: integer or null\n"
        "  billing_period_start: string date (prefer YYYY-MM-DD) or null\n"
        "  billing_period_end: string date (prefer YYYY-MM-DD) or null\n"
        "  total_kwh: number (kWh) or null\n"
        "  daily_avg_kwh: number (kWh/day) or null if not present\n"
        "  tariff_rate: number (AUD per kWh, e.g. 0.32) or null if not present\n"
        "  feed_in_tariff: number (AUD per kWh) or 0 if not present\n"
        "  annual_spend: number (AUD) or null (extrapolate from this bill if needed)\n"
        "  retailer: string or null if not present\n"
        "  plan_name: string or null if not present\n"
        "  historical_usage: array of objects or [] if not present, where each object has:\n"
        "      period_label: string (e.g. 'Jan 2026' or 'Last bill')\n"
        "      kwh: number (kWh)\n"
        "      days: integer (days)\n"
        "  has_solar: boolean (true if solar export data is present, otherwise false)\n"
        "\n"
        "Rules:\n"
        "- If the bill shows cents per kWh, convert to AUD per kWh (e.g. 32 c/kWh -> 0.32).\n"
        "- If multiple tariffs exist, choose the FIRST tier / primary general usage rate.\n"
        "- For annual_spend, if the bill only shows this period spend, extrapolate to annual using days in period.\n"
        "- historical_usage should include as many prior periods as the bill provides.\n"
        "- has_solar should be true if export (kWh) or feed-in credits/rates are present.\n"
        "- Be conservative: if uncertain, set fields to null (except feed_in_tariff=0 and has_solar=false).\n"
    )

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=800,
        temperature=0,
        messages=[
            {
                "role": "user",
                "content": [{"type": "text", "text": prompt}, *image_blocks],
            }
        ],
    )

    # Anthropic returns a list of content blocks; we want the concatenated text.
    response_text = ""
    for block in message.content:
        if getattr(block, "type", None) == "text":
            response_text += block.text

    raw = _extract_json_from_text(response_text)

    # -----------------------------
    # Field validation / defaults
    # -----------------------------
    billing_period_days = _coerce_int(raw.get("billing_period_days"))
    billing_period_start = _coerce_date_iso(raw.get("billing_period_start"))
    billing_period_end = _coerce_date_iso(raw.get("billing_period_end"))
    total_kwh = _coerce_float(raw.get("total_kwh"))
    daily_avg_kwh = _coerce_float(raw.get("daily_avg_kwh"))
    tariff_rate = _coerce_float(raw.get("tariff_rate"))
    feed_in_tariff = _coerce_float(raw.get("feed_in_tariff"))
    annual_spend = _coerce_float(raw.get("annual_spend"))
    retailer = _coerce_str(raw.get("retailer"))
    plan_name = _coerce_str(raw.get("plan_name"))
    historical_usage = _coerce_historical_usage(raw.get("historical_usage"))
    has_solar = _coerce_bool(raw.get("has_solar"))

    # Requirement: feed_in_tariff should be 0 if not present.
    if feed_in_tariff is None:
        feed_in_tariff = 0.0

    # Requirements: predictable defaults for downstream use.
    if historical_usage is None:
        historical_usage = []
    if has_solar is None:
        has_solar = False

    return {
        "billing_period_days": billing_period_days,
        "billing_period_start": billing_period_start,
        "billing_period_end": billing_period_end,
        "total_kwh": total_kwh,
        "daily_avg_kwh": daily_avg_kwh,
        "tariff_rate": tariff_rate,
        "feed_in_tariff": feed_in_tariff,
        "annual_spend": annual_spend,
        "retailer": retailer,
        "plan_name": plan_name,
        "historical_usage": historical_usage,
        "has_solar": has_solar,
    }


# -----------------------------
# Simple smoke test harness
# -----------------------------

def main() -> None:
    """
    Basic test run.

    Ensure you have:
      - Set ANTHROPIC_API_KEY in your environment
      - Added a sample bill at ./test_bill.pdf
    """
    sample_path = "test_bill.pdf"
    try:
        result = parse_bill(sample_path)
        print(json.dumps(result, indent=2))
    except Exception as exc:
        print(f"Failed to parse '{sample_path}': {exc}")


if __name__ == "__main__":
    main()

