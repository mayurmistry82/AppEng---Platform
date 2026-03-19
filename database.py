"""
Firestore persistence for generated reports.

Uses a service account credentials file `firebase-credentials.json`
located in the project root.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


try:
    import firebase_admin
    from firebase_admin import credentials, firestore
except ImportError as exc:  # pragma: no cover
    firebase_admin = None  # type: ignore[assignment]
    credentials = None  # type: ignore[assignment]
    firestore = None  # type: ignore[assignment]
    _FIREBASE_IMPORT_ERROR = exc
else:
    _FIREBASE_IMPORT_ERROR = None


_DB = None


def _get_db():
    """
    Lazily initialize the Firestore client.

    Raises:
      - RuntimeError if firebase-admin isn't installed
      - RuntimeError if credentials file is missing
    """
    global _DB
    if _DB is not None:
        return _DB

    if firebase_admin is None or firestore is None or credentials is None:
        raise RuntimeError(
            "firebase-admin is not installed. Install it to enable report saving."
        ) from _FIREBASE_IMPORT_ERROR

    project_root = Path(__file__).resolve().parent
    cred_path = project_root / "firebase-credentials.json"
    if not cred_path.exists():
        raise RuntimeError(
            f"Missing Firebase service account file: {cred_path}"
        )

    # Initialize the default app if needed.
    if not firebase_admin._apps:
        cred = credentials.Certificate(str(cred_path))
        firebase_admin.initialize_app(cred)

    _DB = firestore.client()
    return _DB


def save_report(report_data: dict) -> str:
    """
    Saves a complete report to Firestore "reports" collection.
    Adds a server timestamp automatically and returns the document ID.
    """
    if not isinstance(report_data, dict):
        raise TypeError("report_data must be a dictionary.")

    db = _get_db()
    payload = dict(report_data)
    payload["timestamp"] = firestore.SERVER_TIMESTAMP

    doc_ref = db.collection("reports").document()
    doc_ref.set(payload)
    return doc_ref.id


def get_reports() -> list[dict[str, Any]]:
    """Returns all reports ordered by timestamp descending."""
    db = _get_db()
    query = db.collection("reports").order_by(
        "timestamp", direction=firestore.Query.DESCENDING
    )
    docs = query.stream()

    results: list[dict[str, Any]] = []
    for doc in docs:
        data = doc.to_dict() or {}
        data["id"] = doc.id
        results.append(data)
    return results


def get_report(report_id: str) -> dict[str, Any]:
    """Returns a single report by document ID."""
    if not report_id or not isinstance(report_id, str):
        raise ValueError("report_id must be a non-empty string.")

    db = _get_db()
    doc = db.collection("reports").document(report_id).get()
    if not doc.exists:
        raise KeyError(f"Report not found: {report_id}")

    data = doc.to_dict() or {}
    data["id"] = doc.id
    return data

