from __future__ import annotations

import os
import tempfile
import uuid
from pathlib import Path

import sentry_sdk
from fastapi import APIRouter, HTTPException, UploadFile, File

import bill_parser

router = APIRouter()

_BILLS_BUCKET = "bills"
_CONTENT_TYPES = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


def _upload_raw_bill(data: bytes, suffix: str) -> str | None:
    """
    Best-effort upload of the raw bill file to Supabase Storage (private 'bills'
    bucket). Returns the storage object path (e.g. 'bills/<uuid>.pdf') or None.

    NEVER raises — a storage failure (missing config, permissions, network) must not
    break bill parsing. On failure it logs to Sentry and returns None. Prefers a
    service-role key if configured, else falls back to the anon key.
    """
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
    if not url or not key:
        return None
    try:
        from supabase import create_client

        object_name = f"{uuid.uuid4().hex}{suffix}"
        content_type = _CONTENT_TYPES.get(suffix, "application/octet-stream")
        client = create_client(url, key)
        client.storage.from_(_BILLS_BUCKET).upload(
            object_name, data, {"content-type": content_type}
        )
        return f"{_BILLS_BUCKET}/{object_name}"
    except Exception as e:  # noqa: BLE001 - best-effort, never propagate
        sentry_sdk.capture_exception(e)
        return None


@router.post("/api/bill/parse")
async def parse_bill(file: UploadFile = File(...)):
    suffix = Path(file.filename or "upload").suffix.lower() or ".pdf"
    tmp_path = None
    try:
        data = await file.read()
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        result = bill_parser.parse_bill(tmp_path)

        # Store the raw bill alongside the parsed output (raw + structured together).
        # Best-effort: never blocks the response — raw_file_path is None on failure.
        result["raw_file_path"] = _upload_raw_bill(data, suffix)
        return result
    except Exception as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if tmp_path:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except Exception:
                pass
