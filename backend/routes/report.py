"""
Report generation endpoint.

Produces an A4 PDF from selected dashboard panels using ReportLab Platypus.
Cover page is always rendered; subsequent pages are one section per selected
panel, in the order provided. Sections without backing data render a
placeholder paragraph rather than failing.
"""

from __future__ import annotations

import io
from datetime import datetime
from typing import Any, Optional

import sentry_sdk
from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.flowables import Flowable, HRFlowable

router = APIRouter()


# Brand palette (print-friendly).
AMBER = HexColor("#FFB428")
DARK = HexColor("#090E1C")
BODY = HexColor("#1E2A3A")
TEXT = HexColor("#F0F4FF")
MUTED = HexColor("#8A99B3")
ROW_ALT = HexColor("#F5F7FA")

PAGE_W, PAGE_H = A4
MARGIN = 2 * cm
CONTENT_W = PAGE_W - 2 * MARGIN

PANEL_LABELS: dict[str, str] = {
    "bill_summary": "Bill Summary",
    "load_profile": "Load Profile",
    "solar_resource": "Solar Resource",
    "roof_geometry": "Roof Geometry",
    "system_sizing": "System Sizing",
    "financial_outcomes": "Financial Outcomes",
    "network_constraints": "Network Constraints",
    "government_incentives": "Government Incentives",
}


class ReportRequest(BaseModel):
    selected_panels: list[str] = []
    bill_data: Optional[dict[str, Any]] = None
    load_profile: Optional[dict[str, Any]] = None
    customer_name: str = ""
    installer_name: str = ""
    installer_company: str = ""


# ── Styles ───────────────────────────────────────────────────────────────────

_styles = getSampleStyleSheet()

_TITLE_STYLE = ParagraphStyle(
    "CoverTitle",
    parent=_styles["Normal"],
    fontName="Helvetica-Bold",
    fontSize=24,
    leading=28,
    textColor=DARK,
    alignment=TA_CENTER,
)

_SUB_STYLE = ParagraphStyle(
    "CoverSub",
    parent=_styles["Normal"],
    fontName="Helvetica",
    fontSize=11,
    leading=14,
    textColor=MUTED,
    alignment=TA_CENTER,
)

_DATE_STYLE = ParagraphStyle(
    "CoverDate",
    parent=_styles["Normal"],
    fontName="Helvetica",
    fontSize=10,
    leading=12,
    textColor=MUTED,
    alignment=TA_CENTER,
)

_BODY_STYLE = ParagraphStyle(
    "Body",
    parent=_styles["Normal"],
    fontName="Helvetica",
    fontSize=10,
    leading=14,
    textColor=DARK,
)

_PLACEHOLDER_STYLE = ParagraphStyle(
    "Placeholder",
    parent=_styles["Normal"],
    fontName="Helvetica",
    fontSize=10,
    leading=14,
    textColor=MUTED,
)


# ── Numbered canvas — two-pass page numbering ────────────────────────────────


class NumberedCanvas(pdfcanvas.Canvas):
    """Two-pass canvas that draws "Page X of Y" on every page except cover."""

    def __init__(self, *args, **kwargs):
        pdfcanvas.Canvas.__init__(self, *args, **kwargs)
        self._saved_page_states: list[dict] = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self._draw_footer(total)
            pdfcanvas.Canvas.showPage(self)
        pdfcanvas.Canvas.save(self)

    def _draw_footer(self, total: int):
        page_num = self._pageNumber
        if page_num <= 1:
            return  # skip cover

        self.saveState()
        # Top rule above footer
        self.setStrokeColor(MUTED)
        self.setLineWidth(0.5)
        self.line(MARGIN, 1.6 * cm, PAGE_W - MARGIN, 1.6 * cm)

        self.setFillColor(MUTED)
        self.setFont("Helvetica-Bold", 8)
        self.drawString(MARGIN, 1.1 * cm, "EnrgEngine")

        self.setFont("Helvetica", 8)
        self.drawCentredString(
            PAGE_W / 2, 1.1 * cm, "Confidential — prepared for installer use"
        )
        self.drawRightString(
            PAGE_W - MARGIN, 1.1 * cm, f"Page {page_num} of {total}"
        )
        self.restoreState()


# ── Section header ───────────────────────────────────────────────────────────


def _section_header(title: str) -> Table:
    t = Table([[title]], colWidths=[CONTENT_W], rowHeights=[28])
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), AMBER),
                ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
                ("FONTNAME", (0, 0), (-1, -1), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 13),
                ("LEFTPADDING", (0, 0), (-1, -1), 12),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    return t


def _data_table(rows: list[list[str]]) -> Table:
    """Two-column key/value table with amber header and alternating rows."""
    t = Table(rows, colWidths=[6 * cm, CONTENT_W - 6 * cm])
    style = TableStyle(
        [
            ("BACKGROUND", (0, 0), (-1, 0), AMBER),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, 0), 10),
            ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
            ("FONTSIZE", (0, 1), (-1, -1), 10),
            ("TEXTCOLOR", (0, 1), (-1, -1), DARK),
            ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("GRID", (0, 0), (-1, -1), 0.5, MUTED),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]
    )
    for i in range(1, len(rows)):
        if i % 2 == 0:
            style.add("BACKGROUND", (0, i), (-1, i), ROW_ALT)
    t.setStyle(style)
    return t


# ── Cover page ───────────────────────────────────────────────────────────────


def _build_cover(
    installer_name: str, installer_company: str, customer_name: str
) -> list[Flowable]:
    elements: list[Flowable] = []
    elements.append(
        HRFlowable(
            width="100%", thickness=2, color=AMBER, spaceBefore=0, spaceAfter=40
        )
    )
    elements.append(Spacer(1, 80))
    elements.append(Paragraph("Solar &amp; Battery Analysis Report", _TITLE_STYLE))
    elements.append(Spacer(1, 40))

    if installer_name and installer_company:
        prep = f"Prepared by: {installer_name} — {installer_company}"
    elif installer_company:
        prep = f"Prepared by: {installer_company}"
    elif installer_name:
        prep = f"Prepared by: {installer_name}"
    else:
        prep = "Prepared by: EnrgEngine"
    elements.append(Paragraph(prep, _SUB_STYLE))

    if customer_name:
        elements.append(Spacer(1, 10))
        elements.append(Paragraph(f"Customer: {customer_name}", _SUB_STYLE))

    elements.append(Spacer(1, 12))
    # %-d isn't portable on Windows; fall back if it fails.
    try:
        today = datetime.now().strftime("%-d %B %Y")
    except ValueError:
        today = datetime.now().strftime("%d %B %Y").lstrip("0")
    elements.append(Paragraph(today, _DATE_STYLE))

    elements.append(Spacer(1, 80))
    elements.append(
        HRFlowable(
            width="100%", thickness=1, color=AMBER, spaceBefore=0, spaceAfter=0
        )
    )
    elements.append(PageBreak())
    return elements


# ── Panel sections ───────────────────────────────────────────────────────────


def _fmt(value: Any, formatter) -> str:
    try:
        return formatter(value)
    except Exception:
        return str(value)


def _bill_summary(bill: Optional[dict[str, Any]]) -> list[Flowable]:
    if not bill:
        return [Paragraph("Bill data not available.", _PLACEHOLDER_STYLE)]

    fields = [
        ("retailer", "Retailer", lambda v: str(v)),
        ("plan_name", "Plan", lambda v: str(v)),
        ("tariff_rate", "Tariff rate", lambda v: f"${float(v):.2f}/kWh"),
        ("feed_in_tariff", "Feed-in tariff", lambda v: f"${float(v):.2f}/kWh"),
        (
            "daily_supply_charge",
            "Supply charge",
            lambda v: f"${float(v):.2f}/day",
        ),
        ("billing_period_days", "Billing days", lambda v: str(int(v))),
        ("total_kwh", "Total usage", lambda v: f"{float(v):,.0f} kWh"),
        ("daily_avg_kwh", "Daily average", lambda v: f"{float(v):.1f} kWh"),
        ("annual_spend", "Annual spend (est.)", lambda v: f"${float(v):,.0f}"),
        ("nmi", "NMI", lambda v: str(v)),
    ]
    rows: list[list[str]] = [["Field", "Value"]]
    for key, label, formatter in fields:
        v = bill.get(key)
        if v is None or v == "":
            continue
        rows.append([label, _fmt(v, formatter)])

    if len(rows) == 1:
        return [Paragraph("Bill data not available.", _PLACEHOLDER_STYLE)]

    return [_data_table(rows)]


def _load_profile_section(lp: Optional[dict[str, Any]]) -> list[Flowable]:
    if not lp:
        return [Paragraph("Load profile not available.", _PLACEHOLDER_STYLE)]

    fields = [
        ("archetype_used", "Archetype", lambda v: str(v)),
        ("annual_kwh", "Annual consumption", lambda v: f"{float(v):,.0f} kWh"),
        ("daily_avg_kwh", "Daily average", lambda v: f"{float(v):.1f} kWh"),
        ("accuracy_tier", "Accuracy tier", lambda v: f"Tier {int(v)}"),
        ("confidence_pct", "Confidence", lambda v: f"{int(v)}%"),
        ("tariff_type_used", "Tariff type", lambda v: str(v)),
    ]
    rows: list[list[str]] = [["Field", "Value"]]
    for key, label, formatter in fields:
        v = lp.get(key)
        if v is None or v == "":
            continue
        rows.append([label, _fmt(v, formatter)])

    if len(rows) == 1:
        return [Paragraph("Load profile not available.", _PLACEHOLDER_STYLE)]

    return [_data_table(rows)]


def _placeholder_section() -> list[Flowable]:
    return [
        Paragraph(
            "This section will be populated once the analysis has been run "
            "from the Inputs tab.",
            _PLACEHOLDER_STYLE,
        )
    ]


def _panel_section(panel_id: str, req: ReportRequest) -> list[Flowable]:
    label = PANEL_LABELS.get(panel_id, panel_id.replace("_", " ").title())
    elements: list[Flowable] = [
        _section_header(label),
        Spacer(1, 16),
    ]
    if panel_id == "bill_summary":
        elements.extend(_bill_summary(req.bill_data))
    elif panel_id == "load_profile":
        elements.extend(_load_profile_section(req.load_profile))
    else:
        elements.extend(_placeholder_section())
    elements.append(PageBreak())
    return elements


# ── Build the document ───────────────────────────────────────────────────────


def build_pdf(req: ReportRequest) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN,
        bottomMargin=MARGIN,
        title="Solar & Battery Analysis Report",
    )

    story: list[Flowable] = []
    story.extend(
        _build_cover(req.installer_name, req.installer_company, req.customer_name)
    )

    for panel_id in req.selected_panels:
        if panel_id not in PANEL_LABELS:
            continue
        story.extend(_panel_section(panel_id, req))

    # Trailing PageBreak left by the last section would create a blank trailing
    # page — strip it if present.
    while story and isinstance(story[-1], PageBreak):
        story.pop()

    doc.build(story, canvasmaker=NumberedCanvas)
    return buf.getvalue()


# ── Endpoint ─────────────────────────────────────────────────────────────────


@router.post("/api/report/generate")
async def generate_report(req: ReportRequest):
    try:
        pdf_bytes = build_pdf(req)
        return StreamingResponse(
            io.BytesIO(pdf_bytes),
            media_type="application/pdf",
            headers={
                "Content-Disposition": "attachment; filename=EnrgEngine-Report.pdf",
            },
        )
    except Exception as e:
        sentry_sdk.capture_exception(e)
        return JSONResponse(
            status_code=500,
            content={"error": "PDF generation failed", "detail": str(e)},
        )
