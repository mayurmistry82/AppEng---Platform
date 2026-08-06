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
import re
from pathlib import Path
from typing import Any

import anthropic
from dotenv import load_dotenv

load_dotenv()


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


# -----------------------------
# Structured tariff (v2) — see docs/2026-06-05-ml-data-flywheel-plan.md §6.
# Adds tariff_structured / parse_confidence / field_provenance / parser_version
# WITHOUT changing any existing key. The scalar tariff_rate is preserved (see
# _derive_scalar_tariff_rate) so sizing_engine / financial_model are unaffected.
# -----------------------------

PARSER_VERSION = "2026-06-10-structured-tariff-v2"

_VALID_TARIFF_TYPES = {"flat", "tou", "demand", "block", "controlled_load"}
_VALID_DAYS = {"weekday", "weekend", "all"}

# Fields we publish per-field confidence + provenance for.
_REPORTED_FIELDS = [
    "billing_period_days", "total_kwh", "daily_avg_kwh", "tariff_rate",
    "feed_in_tariff", "daily_supply_charge", "retailer", "plan_name", "nmi",
    "has_solar", "tariff_structured",
]


def _clamp01(value: float | None) -> float | None:
    if value is None:
        return None
    return max(0.0, min(1.0, value))


def _coerce_time_hhmm(value: Any) -> str | None:
    """Normalise a time to 'HH:MM' (24h). Falls back to the trimmed string."""
    s = _coerce_str(value)
    if s is None:
        return None
    m = re.match(r"^(\d{1,2}):(\d{2})$", s)
    if m:
        return f"{int(m.group(1)):02d}:{m.group(2)}"
    # "2:00pm" / "2 pm" / "2pm"
    m = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$", s.lower())
    if m:
        hour = int(m.group(1)) % 12
        if m.group(3) == "pm":
            hour += 12
        return f"{hour:02d}:{m.group(2) or '00'}"
    m = re.match(r"^(\d{1,2})$", s)
    if m:
        return f"{int(m.group(1)):02d}:00"
    return s


def _normalize_tou_label(label: Any) -> str | None:
    s = _coerce_str(label)
    if s is None:
        return None
    s = s.lower().replace("-", "").replace(" ", "").replace("_", "")
    if s.startswith("peak"):
        return "peak"
    if s.startswith("shoulder"):
        return "shoulder"
    if s.startswith("off"):
        return "offpeak"
    return None


def _coerce_tou_windows(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    out: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        rate = _coerce_float(item.get("rate"))
        label = _normalize_tou_label(item.get("label"))
        days = _coerce_str(item.get("days"))
        days = days.lower() if days else None
        if days not in _VALID_DAYS:
            days = "all"
        start = _coerce_time_hhmm(item.get("start"))
        end = _coerce_time_hhmm(item.get("end"))
        if rate is None and start is None and end is None and label is None:
            continue
        out.append({
            "label": label or "peak",
            "rate": rate,
            "start": start,
            "end": end,
            "days": days,
        })
    return out


def _coerce_dict_list(value: Any, spec: dict[str, str]) -> list[dict[str, Any]]:
    """Coerce a list of dicts against a {key: 'float'|'str'} spec; drop empty rows."""
    if not isinstance(value, list):
        return []
    out: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        row: dict[str, Any] = {}
        has_value = False
        for key, kind in spec.items():
            v = (
                _coerce_float(item.get(key))
                if kind == "float"
                else _coerce_str(item.get(key))
            )
            row[key] = v
            if v is not None:
                has_value = True
        if has_value:
            out.append(row)
    return out


def _build_tariff_structured(
    raw_ts: Any,
    scalar_rate: float | None,
    daily_supply_charge: float | None,
    feed_in_tariff: float | None,
) -> tuple[dict[str, Any], bool]:
    """
    Build the structured tariff. ALWAYS returns a dict (never None) plus a
    `structured_detected` flag. When no genuine multi-window / demand / block /
    controlled-load structure is found, falls back to a single flat all-day window
    built from the scalar tariff_rate.
    """
    raw_ts = raw_ts if isinstance(raw_ts, dict) else {}

    ttype = _coerce_str(raw_ts.get("tariff_type"))
    ttype = ttype.lower() if ttype else None
    if ttype not in _VALID_TARIFF_TYPES:
        ttype = None

    supply_charge = _coerce_float(raw_ts.get("supply_charge"))
    if supply_charge is None:
        supply_charge = daily_supply_charge

    tou_windows = _coerce_tou_windows(raw_ts.get("tou_windows"))
    demand_charges = _coerce_dict_list(
        raw_ts.get("demand_charges"),
        {"rate": "float", "unit": "str", "window": "str", "label": "str"},
    )
    controlled_load = _coerce_dict_list(
        raw_ts.get("controlled_load"),
        {"label": "str", "rate": "float", "description": "str"},
    )
    block_tiers = _coerce_dict_list(
        raw_ts.get("block_tiers"), {"threshold_kwh": "float", "rate": "float"}
    )
    fit_tiers = _coerce_dict_list(
        raw_ts.get("fit_tiers"), {"rate": "float", "threshold_kwh": "float"}
    )

    # A genuinely structured tariff = >1 TOU window, or demand / controlled-load,
    # or >1 block tier. A single window is treated as flat.
    structured_detected = (
        len(tou_windows) > 1
        or bool(demand_charges)
        or bool(controlled_load)
        or len(block_tiers) > 1
    )

    if ttype is None:
        if len(tou_windows) > 1:
            ttype = "tou"
        elif demand_charges:
            ttype = "demand"
        elif controlled_load:
            ttype = "controlled_load"
        elif len(block_tiers) > 1:
            ttype = "block"
        else:
            ttype = "flat"

    # Flat fallback — synthesise a single all-day window from the scalar rate so
    # tariff_structured is never None and always carries at least one usable window.
    if not structured_detected:
        if ttype not in ("demand", "controlled_load", "block"):
            ttype = "flat"
        if not tou_windows:
            tou_windows = [{
                "label": "flat",
                "rate": scalar_rate,
                "start": "00:00",
                "end": "24:00",
                "days": "all",
            }]

    # FiT fallback from the scalar feed-in tariff if none captured structurally.
    if not fit_tiers and feed_in_tariff:
        fit_tiers = [{"rate": feed_in_tariff, "threshold_kwh": None}]

    structured = {
        "tariff_type": ttype,
        "supply_charge": supply_charge,
        "tou_windows": tou_windows,
        "demand_charges": demand_charges,
        "controlled_load": controlled_load,
        "block_tiers": block_tiers,
        "fit_tiers": fit_tiers,
    }
    return structured, structured_detected


def _derive_scalar_tariff_rate(
    scalar_from_claude: float | None, tou_windows: list[dict[str, Any]]
) -> float | None:
    """
    Backwards-compatible scalar tariff_rate (consumed unchanged by sizing_engine /
    financial_model).

    Derivation: if Claude extracted a scalar general-usage rate it is returned
    UNCHANGED — identical to the pre-v2 behaviour, so existing callers get the same
    numbers. Only when the scalar is missing do we derive a representative scalar
    from the TOU windows: the peak-window rate if present, else the first window with
    a rate.
    """
    if scalar_from_claude is not None:
        return scalar_from_claude
    peak = next(
        (
            w["rate"]
            for w in tou_windows
            if w.get("label") == "peak" and w.get("rate") is not None
        ),
        None,
    )
    if peak is not None:
        return peak
    return next((w["rate"] for w in tou_windows if w.get("rate") is not None), None)


def _build_confidence(
    raw_conf: Any, present: dict[str, bool], scalar_from_claude: bool
) -> dict[str, float]:
    """Per-field 0.0-1.0 confidence. Prefers Claude's self-reported value, else a
    sensible default; capped low when the value was not actually extracted."""
    rc = raw_conf if isinstance(raw_conf, dict) else {}
    conf: dict[str, float] = {}
    for f in _REPORTED_FIELDS:
        claude_c = _clamp01(_coerce_float(rc.get(f)))
        is_present = bool(present.get(f))
        if f == "tariff_structured":
            base = 0.75 if is_present else 0.2
            conf[f] = round(claude_c, 3) if (is_present and claude_c is not None) else base
            continue
        if f == "tariff_rate":
            base = 0.85 if scalar_from_claude else (0.5 if is_present else 0.1)
        else:
            base = 0.8 if is_present else 0.1
        c = claude_c if claude_c is not None else base
        if not is_present:
            c = min(c, 0.2)
        conf[f] = round(c, 3)
    return conf


def _build_provenance(present: dict[str, bool]) -> dict[str, str]:
    """'extracted' if the value came from the bill, else 'default' (substituted)."""
    return {f: ("extracted" if present.get(f) else "default") for f in _REPORTED_FIELDS}


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
      - nmi: National Metering Identifier (10-11 digit string) or None
      - daily_supply_charge: daily supply charge in AUD per day, or None

    v2 additions (all keys above are unchanged for existing callers):
      - tariff_structured: full structured tariff (never None) —
            {tariff_type, supply_charge, tou_windows[], demand_charges[],
             controlled_load[], block_tiers[], fit_tiers[]}. Falls back to a single
             flat all-day window built from tariff_rate when no TOU/demand/block/
             controlled-load structure is detected.
      - parse_confidence: {field_name: 0.0-1.0} per-field extraction confidence.
      - field_provenance: {field_name: "extracted" | "default"}.
      - parser_version: version stamp of this parser.

    The scalar tariff_rate is RETAINED unchanged when Claude extracts one; when it is
    missing it is derived from tariff_structured (peak window, else first window rate)
    so sizing_engine / financial_model keep working with identical numbers.
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
        "  historical_usage: array of objects or [] — ONLY populate from actual previous\n"
        "      billing period data shown in a printed table or account summary section\n"
        "      (e.g. labelled 'Previous bills', 'Account history', 'Invoice summary',\n"
        "      'Billing history'). DO NOT read from the visual usage history bar chart\n"
        "      or graph printed on the bill — those figures are rounded estimates, not\n"
        "      actual meter reads. Each object has:\n"
        "      period_label: string (e.g. 'Jan–Mar 2025' or 'Previous bill')\n"
        "      kwh: number (kWh — actual billed figure from table, not chart estimate)\n"
        "      days: integer (days in that billing period, or null if not shown)\n"
        "  has_solar: boolean (true if solar export data is present, otherwise false)\n"
        "  nmi: string (National Metering Identifier — 10 or 11 digit number, often labelled 'NMI' on the bill) or null if not present\n"
        "  daily_supply_charge: number (AUD per day, e.g. 1.12) or null if not present. Look for 'daily supply charge', 'service to property', 'network charge', or similar. Convert to AUD/day if shown as a total for the period (divide total by billing_period_days).\n"
        "  property_address: string (the supply/service address — the property the\n"
        "      electricity is supplied to, usually labelled 'Supply address',\n"
        "      'Property address', 'Service address', or 'Site address' on the bill.\n"
        "      Do NOT use the mailing/postal address. Return null if not found.\n"
        "  customer_name: string (the account holder name or customer name as printed\n"
        "      on the bill, usually near the top. Return null if not found.)\n"
        "  tariff_structured: object describing the FULL tariff structure, with keys:\n"
        "      tariff_type: one of \"flat\",\"tou\",\"demand\",\"block\",\"controlled_load\"\n"
        "          (use \"tou\" when peak/off-peak/shoulder time-of-use windows exist;\n"
        "          \"flat\" for a single all-day general usage rate)\n"
        "      supply_charge: number (AUD per day) or null\n"
        "      tou_windows: array (use [] for a flat tariff) of objects, one per time band:\n"
        "          label: \"peak\" | \"shoulder\" | \"offpeak\"\n"
        "          rate: number (AUD per kWh)\n"
        "          start: \"HH:MM\" 24-hour (e.g. \"14:00\")\n"
        "          end: \"HH:MM\" 24-hour (e.g. \"20:00\")\n"
        "          days: \"weekday\" | \"weekend\" | \"all\"\n"
        "      demand_charges: array (or []) of objects: {rate: number (AUD per kW), unit: string|null, window: string|null, label: string|null}\n"
        "      controlled_load: array (or []) of objects: {label: string|null, rate: number (AUD per kWh), description: string|null}\n"
        "      block_tiers: array (or []) of objects: {threshold_kwh: number|null, rate: number (AUD per kWh)}\n"
        "      fit_tiers: array (or []) of objects: {rate: number (AUD per kWh), threshold_kwh: number|null}\n"
        "  confidence: object mapping these field names to a number 0.0-1.0 indicating how\n"
        "      confident you are in each extracted value: total_kwh, daily_avg_kwh,\n"
        "      tariff_rate, feed_in_tariff, daily_supply_charge, billing_period_days,\n"
        "      retailer, plan_name, nmi, tariff_structured. Use ~0.95 for clearly printed\n"
        "      values, ~0.5 if inferred or ambiguous, and a low value if you had to guess.\n"
        "\n"
        "Rules:\n"
        "- If the bill shows cents per kWh, convert to AUD per kWh (e.g. 32 c/kWh -> 0.32).\n"
        "- If multiple tariffs exist, choose the FIRST tier / primary general usage rate.\n"
        "- For annual_spend, if the bill only shows this period spend, extrapolate to annual using days in period.\n"
        "- historical_usage: ONLY extract from tabular data (invoice summary tables,\n"
        "  account history tables, previous billing period sections with exact kWh\n"
        "  figures). NEVER extract from visual bar charts or usage graphs — these are\n"
        "  approximations, not meter reads. If the only historical data visible is a\n"
        "  bar chart or graph, return [] for historical_usage.\n"
        "- has_solar should be true if export (kWh) or feed-in credits/rates are present.\n"
        "- For daily_supply_charge: if the bill shows a total supply charge for the period (e.g. \"$86.53 for 77 days\"), divide by days to get the daily rate. If shown as a per-day rate directly, use that.\n"
        "- NMI is typically a 10-11 digit number near the top of the bill, labelled \"NMI\", \"National Metering Identifier\", or \"Meter ID\".\n"
        "- property_address: extract the supply/service address only — the physical\n"
        "  property being billed. Exclude state/postcode if unclear; include if visible.\n"
        "  Return null if only a PO Box or mailing address is present.\n"
        "- customer_name: extract as printed. Do not infer or guess. Return null if\n"
        "  not clearly present.\n"
        "- tariff_structured: capture time-of-use windows with their exact time bands and\n"
        "  rates when present (peak / shoulder / off-peak). If the bill has only a single\n"
        "  general usage rate, set tariff_type=\"flat\" and tou_windows=[]. Include demand\n"
        "  charges (AUD/kW), controlled-load / off-peak hot water rates, and block/stepped\n"
        "  tiers when shown. Convert any cents to AUD per unit. Use [] for sections not present.\n"
        "- tariff_rate (the scalar) must stay the primary general-usage rate as before — for\n"
        "  a TOU bill, that is the peak / main usage rate.\n"
        "- Be conservative: if uncertain, set fields to null (except feed_in_tariff=0 and has_solar=false).\n"
    )

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
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
    # Scalar rate exactly as Claude extracted it (pre-v2 behaviour). The final
    # tariff_rate is derived from this below — unchanged when present.
    claude_scalar_rate = _coerce_float(raw.get("tariff_rate"))
    feed_in_raw = _coerce_float(raw.get("feed_in_tariff"))
    annual_spend = _coerce_float(raw.get("annual_spend"))
    retailer = _coerce_str(raw.get("retailer"))
    plan_name = _coerce_str(raw.get("plan_name"))
    historical_usage = _coerce_historical_usage(raw.get("historical_usage"))
    has_solar_raw = _coerce_bool(raw.get("has_solar"))
    nmi = _coerce_str(raw.get("nmi"))
    daily_supply_charge = _coerce_float(raw.get("daily_supply_charge"))
    property_address = _coerce_str(raw.get("property_address"))
    customer_name = _coerce_str(raw.get("customer_name"))

    # Requirement: feed_in_tariff should be 0 if not present (track provenance).
    feed_in_provided = feed_in_raw is not None
    feed_in_tariff = feed_in_raw if feed_in_raw is not None else 0.0

    # Predictable defaults for downstream use (track provenance for has_solar).
    has_solar_provided = has_solar_raw is not None
    has_solar = has_solar_raw if has_solar_raw is not None else False
    if historical_usage is None:
        historical_usage = []

    # Structured tariff (v2) — always returns a dict; flat fallback when no real
    # TOU/demand/block/controlled-load structure is detected.
    tariff_structured, structured_detected = _build_tariff_structured(
        raw.get("tariff_structured"),
        claude_scalar_rate,
        daily_supply_charge,
        feed_in_tariff,
    )
    # Backwards-compatible scalar: unchanged when Claude extracted one (so
    # sizing_engine / financial_model produce the same numbers); derived from the
    # TOU windows only when the scalar is missing.
    tariff_rate = _derive_scalar_tariff_rate(
        claude_scalar_rate, tariff_structured["tou_windows"]
    )

    present_flags = {
        "billing_period_days": billing_period_days is not None,
        "total_kwh": total_kwh is not None,
        "daily_avg_kwh": daily_avg_kwh is not None,
        "tariff_rate": tariff_rate is not None,
        "feed_in_tariff": feed_in_provided,
        "daily_supply_charge": daily_supply_charge is not None,
        "retailer": retailer is not None,
        "plan_name": plan_name is not None,
        "nmi": nmi is not None,
        "has_solar": has_solar_provided,
        "tariff_structured": structured_detected,
    }
    parse_confidence = _build_confidence(
        raw.get("confidence"), present_flags, claude_scalar_rate is not None
    )
    field_provenance = _build_provenance(present_flags)

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
        "nmi": nmi,
        "daily_supply_charge": daily_supply_charge,
        "property_address": property_address,
        "customer_name": customer_name,
        # v2 additions (see docs/2026-06-05-ml-data-flywheel-plan.md §6) — all existing
        # keys above are unchanged.
        "tariff_structured": tariff_structured,
        "parse_confidence": parse_confidence,
        "field_provenance": field_provenance,
        "parser_version": PARSER_VERSION,
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

