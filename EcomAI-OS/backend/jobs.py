"""Durable asynchronous job infrastructure for EcomAI-OS (spec §38).

Accepted long-running work follows the documented contract::

    POST /api/...            → 202 Accepted {job_id, status: "queued"}
    GET  /api/jobs/{job_id}  → {status, progress, result | error}

The registry uses SQLite by default so status records survive a process
restart.  Execution of a concrete coroutine is still local to the process
that accepted it; a queued record can therefore be inspected truthfully but
is not claimed to have run without an executable worker.  A future worker can
claim the same durable rows and execute them using its own operation registry.

Security and correctness rules:

* Jobs are keyed by the verified tenant identity and every lookup is checked by
  the route before returning a record.
* The SQLite file contains lifecycle metadata and results, never bearer tokens,
  passwords, or service-role credentials.
* Interrupted ``running`` rows are marked failed on startup rather than being
  presented as still running forever.
* Errors are surfaced as bounded, friendly copy; tracebacks and credential
  values are never returned.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import threading
import uuid
import math
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Iterator, List, Optional

from backend.config import _load_dotenv_files

JOB_QUEUED = "queued"
JOB_RUNNING = "running"
JOB_SUCCEEDED = "succeeded"
JOB_FAILED = "failed"

VALID_TRANSITIONS = {
    JOB_QUEUED: (JOB_RUNNING, JOB_FAILED),
    JOB_RUNNING: (JOB_SUCCEEDED, JOB_FAILED),
    JOB_SUCCEEDED: (),
    JOB_FAILED: (),
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_database_path() -> str:
    _load_dotenv_files()
    configured = os.environ.get("JOB_DATABASE_PATH", "").strip()
    if configured:
        return configured
    # Local runtime state is intentionally outside the source tree's tracked
    # data files.  Deployments may set JOB_DATABASE_PATH to a mounted volume.
    return str(Path(__file__).resolve().parents[1] / "data" / "runtime" / "jobs.sqlite3")


def _default_job_timeout() -> float:
    _load_dotenv_files()
    raw = os.environ.get("DEFAULT_JOB_TIMEOUT_S", "300").strip()
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("DEFAULT_JOB_TIMEOUT_S must be a finite number.") from exc
    if not math.isfinite(value) or value < 1.0 or value > 86400.0:
        raise RuntimeError("DEFAULT_JOB_TIMEOUT_S must be between 1 and 86400 seconds.")
    return value


@dataclass
class Job:
    job_id: str
    user_id: str
    job_type: str
    status: str = JOB_QUEUED
    progress: float = 0.0            # 0..1 internally; percentage in the API
    progress_label: str = "Queued"
    created_at: str = ""
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    result: Optional[Dict[str, Any]] = None
    error_detail: Optional[str] = None   # friendly copy only
    meta: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "job_id": self.job_id,
            "user_id": self.user_id,
            "job_type": self.job_type,
            "status": self.status,
            "progress": round(self.progress * 100, 1),   # percent for the UI
            "progress_label": self.progress_label,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "result": self.result,
            "error": self.error_detail,
        }


def _safe_store_value(value: Any) -> Any:
    """Remove common credential-bearing fields before durable persistence."""

    if isinstance(value, dict):
        safe: Dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            lowered = key_text.casefold()
            if any(marker in lowered for marker in (
                "password", "secret", "authorization", "access_token",
                "refresh_token", "api_key", "apikey", "service_role", "bearer",
                "jwt", "credential",
            )):
                safe[key_text] = "[redacted]"
            else:
                safe[key_text] = _safe_store_value(item)
        return safe
    if isinstance(value, (list, tuple)):
        return [_safe_store_value(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _json_dumps(value: Any) -> str:
    try:
        return json.dumps(
            _safe_store_value(value),
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        )
    except (TypeError, ValueError):
        return "null"


def _json_loads(value: Optional[str], fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback
    return parsed


class _SQLiteJobStore:
    """Small SQLite adapter with one short transaction per operation."""

    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._shared_connection: Optional[sqlite3.Connection] = None
        if path == ":memory:":
            self._shared_connection = sqlite3.connect(
                ":memory:", check_same_thread=False, timeout=5.0
            )
        else:
            database_path = Path(path).expanduser()
            database_path.parent.mkdir(parents=True, exist_ok=True)
            self.path = str(database_path)

        with self._lock, self._connection() as connection:
            connection.execute(
                """
                create table if not exists jobs (
                    job_id text primary key,
                    user_id text not null,
                    job_type text not null,
                    status text not null,
                    progress real not null default 0,
                    progress_label text not null default 'Queued',
                    created_at text not null,
                    started_at text,
                    finished_at text,
                    result_json text,
                    error_detail text,
                    meta_json text not null default '{}'
                )
                """
            )
            connection.execute(
                "create index if not exists jobs_user_created_idx "
                "on jobs (user_id, created_at desc)"
            )

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        self._lock.acquire()
        own_connection = self._shared_connection is None
        connection = self._shared_connection or sqlite3.connect(
            self.path,
            timeout=5.0,
            check_same_thread=False,
        )
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("pragma busy_timeout = 5000")
            if own_connection:
                connection.execute("pragma journal_mode = WAL")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            if own_connection:
                connection.close()
            self._lock.release()

    @staticmethod
    def _row_to_job(row: sqlite3.Row) -> Job:
        values = dict(row)
        result = _json_loads(values.get("result_json"), None)
        meta = _json_loads(values.get("meta_json"), {})
        if not isinstance(result, dict):
            result = None
        if not isinstance(meta, dict):
            meta = {}
        return Job(
            job_id=str(values["job_id"]),
            user_id=str(values["user_id"]),
            job_type=str(values["job_type"]),
            status=str(values["status"]),
            progress=float(values.get("progress") or 0.0),
            progress_label=str(values.get("progress_label") or "Queued"),
            created_at=str(values.get("created_at") or ""),
            started_at=values.get("started_at"),
            finished_at=values.get("finished_at"),
            result=result,
            error_detail=values.get("error_detail"),
            meta=meta,
        )

    def upsert(self, job: Job) -> None:
        with self._connection() as connection:
            connection.execute(
                """
                insert into jobs (
                    job_id, user_id, job_type, status, progress,
                    progress_label, created_at, started_at, finished_at,
                    result_json, error_detail, meta_json
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(job_id) do update set
                    user_id=excluded.user_id,
                    job_type=excluded.job_type,
                    status=excluded.status,
                    progress=excluded.progress,
                    progress_label=excluded.progress_label,
                    started_at=excluded.started_at,
                    finished_at=excluded.finished_at,
                    result_json=excluded.result_json,
                    error_detail=excluded.error_detail,
                    meta_json=excluded.meta_json
                """,
                (
                    job.job_id,
                    job.user_id,
                    job.job_type,
                    job.status,
                    float(job.progress),
                    job.progress_label,
                    job.created_at,
                    job.started_at,
                    job.finished_at,
                    _json_dumps(job.result) if job.result is not None else None,
                    job.error_detail,
                    _json_dumps(job.meta or {}),
                ),
            )

    def get(self, job_id: str) -> Optional[Job]:
        with self._connection() as connection:
            row = connection.execute(
                "select * from jobs where job_id = ?", (job_id,)
            ).fetchone()
        return self._row_to_job(row) if row is not None else None

    def all(self) -> List[Job]:
        with self._connection() as connection:
            rows = connection.execute(
                "select * from jobs order by created_at desc"
            ).fetchall()
        return [self._row_to_job(row) for row in rows]

    def close(self) -> None:
        with self._lock:
            if self._shared_connection is not None:
                self._shared_connection.close()
                self._shared_connection = None


class JobRegistry:
    """Durable job registry with asyncio execution for concrete operations."""

    def __init__(
        self,
        db_path: Optional[str] = None,
        *,
        timeout_seconds: Optional[float] = None,
    ) -> None:
        self._db_path = db_path if db_path is not None else _default_database_path()
        self._timeout_seconds = (
            _default_job_timeout() if timeout_seconds is None else float(timeout_seconds)
        )
        if not math.isfinite(self._timeout_seconds) or self._timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be a positive finite number.")
        self._store = _SQLiteJobStore(self._db_path)
        self._jobs: Dict[str, Job] = {}
        self._tasks: Dict[str, asyncio.Task] = {}
        self._lock = threading.RLock()
        self._refresh_from_store()
        self._recover_interrupted()

    # ------------------------------------------------------------------ pub

    def create_job(
        self,
        *,
        user_id: str,
        job_type: str,
        meta: Optional[Dict[str, Any]] = None,
    ) -> Job:
        if user_id is None or job_type is None:
            raise ValueError("user_id and job_type are required for a job.")
        user_id = str(user_id).strip()
        job_type = str(job_type).strip()
        if not user_id or not job_type:
            raise ValueError("user_id and job_type are required for a job.")
        job = Job(
            job_id=uuid.uuid4().hex,
            user_id=user_id,
            job_type=job_type,
            created_at=_now(),
            meta=meta or {},
        )
        self._store.upsert(job)
        with self._lock:
            self._jobs[job.job_id] = job
        return job

    def get_job(self, job_id: str) -> Optional[Job]:
        if not job_id:
            return None
        try:
            stored = self._store.get(str(job_id))
        except sqlite3.Error:
            stored = None
        if stored is not None:
            with self._lock:
                self._jobs[stored.job_id] = stored
            return stored
        with self._lock:
            return self._jobs.get(str(job_id))

    def list_jobs(self, user_id: Optional[str] = None) -> List[Job]:
        try:
            self._refresh_from_store()
        except sqlite3.Error:
            pass
        with self._lock:
            jobs = list(self._jobs.values())
        if user_id is not None:
            normalized = str(user_id).strip()
            jobs = [job for job in jobs if job.user_id == normalized]
        return sorted(jobs, key=lambda job: job.created_at, reverse=True)

    def mark_running(self, job: Job) -> Job:
        """Transition a queued job to the visible running state."""
        if job.status != JOB_QUEUED:
            raise ValueError("Only a queued job can be marked running.")
        job.status = JOB_RUNNING
        job.progress_label = "Running"
        job.started_at = _now()
        job.error_detail = None
        self._persist(job)
        return job

    def mark_succeeded(
        self, job: Job, result: Optional[Dict[str, Any]] = None
    ) -> Job:
        """Mark a running job complete and retain its structured result."""
        if job.status != JOB_RUNNING:
            raise ValueError("Only a running job can be marked succeeded.")
        if result is None:
            job.result = None
        else:
            safe_result = _safe_store_value(result)
            job.result = (
                safe_result
                if isinstance(safe_result, dict)
                else {"payload": safe_result}
            )
        job.error_detail = None
        job.progress = 1.0
        job.progress_label = "Complete"
        job.status = JOB_SUCCEEDED
        job.finished_at = _now()
        self._persist(job)
        return job

    def mark_failed(self, job: Job, detail: Optional[str] = None) -> Job:
        """Move a non-terminal job to a safe, friendly failed state."""
        if job.status not in {JOB_QUEUED, JOB_RUNNING}:
            raise ValueError("Only a queued or running job can be marked failed.")
        job.status = JOB_FAILED
        job.error_detail = friendly_error(
            str(detail) if detail else "The operation failed."
        )
        job.finished_at = _now()
        self._persist(job)
        return job

    def start(self, job: Job, coro: Awaitable) -> asyncio.Task:
        """Run ``coro`` in the background and persist every lifecycle change.

        The job remains visibly ``queued`` until the event loop starts the task,
        so the 202 response never claims work has already completed.
        """
        if job.status != JOB_QUEUED:
            raise ValueError("Only a queued job can be started.")

        async def _run() -> None:
            self.mark_running(job)
            try:
                result = await asyncio.wait_for(coro, timeout=self._timeout_seconds)
                self.mark_succeeded(
                    job,
                    result=result if isinstance(result, dict) else {"payload": result},
                )
            except asyncio.TimeoutError:
                self.mark_failed(
                    job,
                    detail="The operation exceeded the configured time limit.",
                )
            except asyncio.CancelledError:
                self.mark_failed(
                    job, detail="The operation was cancelled before it completed."
                )
            except Exception as exc:  # noqa: BLE001 — always a final transition
                self.mark_failed(job, detail=str(exc))
            finally:
                job.finished_at = job.finished_at or _now()
                with self._lock:
                    self._tasks.pop(job.job_id, None)

        try:
            task = asyncio.create_task(_run())
        except Exception:
            # Avoid an un-awaited coroutine warning if the event loop refuses
            # the task after the request has already been accepted.
            close = getattr(coro, "close", None)
            if callable(close):
                close()
            self.mark_failed(job, detail="The operation could not be scheduled.")
            raise
        with self._lock:
            self._tasks[job.job_id] = task
        return task

    def close(self) -> None:
        """Release the SQLite connection; active asyncio tasks are untouched."""
        self._store.close()

    # ----------------------------------------------------------------- internal

    def _persist(self, job: Job) -> None:
        try:
            self._store.upsert(job)
        except sqlite3.Error:
            # Lifecycle state remains truthful in the running process. The
            # database error is not allowed to mask the operation's own result;
            # a deployment should monitor the runtime volume/permissions.
            return
        with self._lock:
            self._jobs[job.job_id] = job

    def _refresh_from_store(self) -> None:
        for job in self._store.all():
            with self._lock:
                self._jobs[job.job_id] = job

    def _recover_interrupted(self) -> None:
        """Never leave a job from a dead process permanently ``running``."""

        for job in list(self._jobs.values()):
            if job.status != JOB_RUNNING:
                continue
            job.status = JOB_FAILED
            job.error_detail = (
                "The operation was interrupted by a server restart and was not "
                "completed."
            )
            job.finished_at = job.finished_at or _now()
            self._persist(job)


def friendly_error(raw: str) -> str:
    """Return a bounded, user-safe error without traceback or secret leakage."""
    if raw is None:
        return "The operation failed with no further detail."
    if not isinstance(raw, str):
        raw = str(raw)
    if not raw:
        return "The operation failed with no further detail."
    lines = [line for line in raw.splitlines() if line.strip()]
    if not lines:
        return "The operation failed with no further detail."
    first = lines[0].strip()
    trace_markers = ("Traceback", 'File "', "site-packages", "  at ")
    if first.startswith(trace_markers) or any(marker in first for marker in trace_markers):
        return "The operation could not complete for this product or file."

    # Redact common credential-bearing forms before returning any message.
    first = re.sub(r"(?i)\bBearer\s+[^\s,;]+", "Bearer [redacted]", first)
    secret_pattern = re.compile(
        r"(?i)(authorization|apikey|api[_-]?key|service[_-]?role(?:[_-]?key)?|"
        r"access[_-]?token|refresh[_-]?token|supabase[_-]?service[_-]?role[_-]?key)"
        r"\s*[:=]\s*[^\s,;]+"
    )
    first = secret_pattern.sub(r"\1=[redacted]", first)
    first = re.sub(
        r"(?i)\b(?:sb_(?:secret|publishable)_[A-Za-z0-9_-]+|"
        r"eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){1,2})\b",
        "[redacted]",
        first,
    )
    if "SUPABASE_SERVICE_ROLE_KEY" in first.upper():
        return "The operation could not complete for this product or file."
    if len(first) > 300:
        return "The operation could not complete for this product or file."
    return first
