"""
Address autocomplete proxy — Google Places API (New), checklist 3.2.

Two endpoints, BOTH behind require_company: an unauthenticated proxy in front
of a billable API is a quota-drain vulnerability, so these are treated exactly
like the job routes — security, not convenience.

BILLING (why the shape is prescribed): with a per-lookup session token,
"Autocomplete Session Usage" is unlimited and free and only the single Place
Details call bills ("Place Details Essentials", 10k/month free). The client
generates one UUID per lookup, sends it with every keystroke request AND the
final details request, then discards it. This proxy just forwards it.

Surface: Places API (New), v1 — verified against Google's docs 2026-08-13.
  POST https://places.googleapis.com/v1/places:autocomplete
       headers X-Goog-Api-Key; body {input, sessionToken, includedRegionCodes,
       includedPrimaryTypes}
  GET  https://places.googleapis.com/v1/places/{place_id}
       headers X-Goog-Api-Key, X-Goog-FieldMask: formattedAddress,location
       ?sessionToken=... closes the autocomplete session for billing.

Responses are MINIMAL — Google's payload is never passed through raw, and the
API key never appears in a response, a log line, or an error message.

NEVER RAISES to the caller: any upstream failure returns an empty suggestion
list (or nulls for details), never a 500. A dead suggester must not break the
New Job form — the field keeps working as plain text.

Key: GOOGLE_MAPS_API_KEY — this name and no other (F40).
"""

from __future__ import annotations

import os
import time
from typing import Optional

import requests
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from auth import Caller, require_company

router = APIRouter()

AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete"
DETAILS_URL = "https://places.googleapis.com/v1/places"

# Same retry shape as roof_geometry._get_with_retry (429/5xx, exponential
# backoff), duplicated rather than imported so this module cannot grow a
# dependency on roof logic — plus a POST variant for the new API's verb.
MAX_RETRIES = 3
TIMEOUT = 10  # type-ahead: fail fast, the field degrades to plain text


def _request_with_retry(
    method: str,
    url: str,
    *,
    headers: dict,
    params: Optional[dict] = None,
    json: Optional[dict] = None,
) -> requests.Response:
    delay = 1.0
    last: Optional[requests.Response] = None
    for attempt in range(MAX_RETRIES):
        resp = requests.request(
            method, url, headers=headers, params=params, json=json, timeout=TIMEOUT
        )
        last = resp
        if resp.status_code == 429 or resp.status_code >= 500:
            if attempt < MAX_RETRIES - 1:
                time.sleep(delay)
                delay *= 2
                continue
        return resp
    return last  # type: ignore[return-value]


class AutocompleteRequest(BaseModel):
    input: str = Field(min_length=1, max_length=200)
    session_token: str = Field(min_length=1, max_length=64)


class DetailsRequest(BaseModel):
    place_id: str = Field(min_length=1, max_length=512)
    session_token: str = Field(min_length=1, max_length=64)


@router.post("/api/address/autocomplete")
async def address_autocomplete(
    body: AutocompleteRequest, caller: Caller = Depends(require_company)
):
    """AU address suggestions. Always 200 with {suggestions: [...]} — possibly empty."""
    key = os.getenv("GOOGLE_MAPS_API_KEY")
    # Shorter than 3 characters is never sent upstream (billing hygiene) —
    # the client also guards this; this is the server-side backstop.
    if not key or len(body.input.strip()) < 3:
        return {"suggestions": []}
    try:
        resp = _request_with_retry(
            "POST",
            AUTOCOMPLETE_URL,
            headers={"X-Goog-Api-Key": key, "Content-Type": "application/json"},
            json={
                "input": body.input,
                "sessionToken": body.session_token,
                "includedRegionCodes": ["au"],
                # Table B address types are valid includedPrimaryTypes values
                # for Autocomplete (New); restricts to street-level results.
                "includedPrimaryTypes": ["street_address", "premise", "subpremise", "route"],
            },
        )
        data = resp.json()
    except Exception:  # noqa: BLE001 — degrade silently; never surface upstream detail
        return {"suggestions": []}

    suggestions = []
    for item in data.get("suggestions", []) or []:
        prediction = item.get("placePrediction") or {}
        place_id = prediction.get("placeId")
        description = ((prediction.get("text") or {}).get("text")) or None
        if place_id and description:
            suggestions.append({"place_id": place_id, "description": description})
    return {"suggestions": suggestions}


@router.post("/api/address/details")
async def address_details(
    body: DetailsRequest, caller: Caller = Depends(require_company)
):
    """Resolve one selected suggestion. Nulls on any failure — never a 500."""
    empty = {"formatted_address": None, "lat": None, "lng": None}
    key = os.getenv("GOOGLE_MAPS_API_KEY")
    if not key:
        return empty
    try:
        resp = _request_with_retry(
            "GET",
            f"{DETAILS_URL}/{body.place_id}",
            headers={
                "X-Goog-Api-Key": key,
                "X-Goog-FieldMask": "formattedAddress,location",
            },
            params={"sessionToken": body.session_token},
        )
        data = resp.json()
    except Exception:  # noqa: BLE001
        return empty

    location = data.get("location") or {}
    return {
        "formatted_address": data.get("formattedAddress"),
        "lat": location.get("latitude"),
        "lng": location.get("longitude"),
    }
