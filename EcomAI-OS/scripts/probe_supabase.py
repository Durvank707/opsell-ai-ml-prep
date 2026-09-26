"""Read-only Supabase connectivity/schema probe.

Never prints key material. Run manually, not as part of the test suite.
"""

from __future__ import annotations

import json
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from backend.config import Settings


def main() -> int:
    settings = Settings()
    print(f"use_supabase      : {settings.use_supabase}")
    print(f"supabase_url      : {settings.supabase_url or '<unset>'}")
    print(f"service_role_key  : {'present' if settings.supabase_service_role_key else 'MISSING'}")
    print(f"publishable_key   : {'present' if settings.supabase_publishable_key else 'MISSING'}")
    if not settings.use_supabase:
        print("\nUSE_SUPABASE is false; nothing to probe.")
        return 1

    base = settings.supabase_url.rstrip("/")
    headers = {
        "apikey": settings.supabase_service_role_key,
        "Authorization": f"Bearer {settings.supabase_service_role_key}",
        "Accept": "application/json",
    }

    for table in ("sales", "products", "audit_entries"):
        url = f"{base}/rest/v1/{table}?select=*&limit=1"
        request = Request(url, headers=headers, method="GET")
        try:
            with urlopen(request, timeout=15) as response:
                body = response.read(4096)
            rows = json.loads(body or b"[]")
            print(f"\n[OK]   {table}: reachable, sample rows={len(rows)}")
            if rows:
                print(f"       columns: {sorted(rows[0].keys())}")
        except HTTPError as exc:
            detail = exc.read(600).decode("utf-8", "replace")
            print(f"\n[{exc.code}] {table}: {detail}")
        except URLError as exc:
            print(f"\n[NET]  {table}: {exc.reason}")
        except Exception as exc:  # noqa: BLE001
            print(f"\n[ERR]  {table}: {type(exc).__name__}: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
