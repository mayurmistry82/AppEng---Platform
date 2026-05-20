from __future__ import annotations

import tempfile
from pathlib import Path

import sentry_sdk
from fastapi import APIRouter, HTTPException, UploadFile, File

import bill_parser

router = APIRouter()


@router.post("/api/bill/parse")
async def parse_bill(file: UploadFile = File(...)):
    suffix = Path(file.filename or "upload").suffix.lower() or ".pdf"
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name
        result = bill_parser.parse_bill(tmp_path)
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
