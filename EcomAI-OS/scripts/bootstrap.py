"""Prepare a fresh clone for a working backend: seed data, then train the model.

``data/raw/*.csv``, ``data/processed/*.csv`` and ``models/*.joblib`` are all
git-ignored, so a fresh clone has none of them and the backend cannot start --
``EcomAIService.load_resources`` requires the sales store, the inventory
snapshot and the trained forecaster, and ``/api/health`` fails without them.
This script rebuilds exactly those, in the order they depend on each other:

1. ``data/raw/sales.csv``            -- ``scripts/generate_data.py``
2. ``data/raw/inventory_snapshot.csv`` -- ``scripts/generate_inventory.py``
3. ``models/xgboost_forecaster.joblib`` and ``data/processed/forecast_error_std.csv``
   -- ``train.py``

Steps 1 and 2 are the repository's existing data generators, run as-is; step 3
is the existing training pipeline. Nothing here invents data or fakes a model:
if a step cannot run, this script fails and says why.

Every step is idempotent and skipped when its output already exists, so
re-running is cheap and safe. Pass ``--force`` to rebuild everything from
scratch. Run with ``--status`` to report what is present without changing
anything.
"""

from __future__ import annotations

import argparse
import runpy
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

SALES_CSV = PROJECT_ROOT / "data" / "raw" / "sales.csv"
INVENTORY_CSV = PROJECT_ROOT / "data" / "raw" / "inventory_snapshot.csv"
MODEL_PATH = PROJECT_ROOT / "models" / "xgboost_forecaster.joblib"
ERROR_STD_PATH = PROJECT_ROOT / "data" / "processed" / "forecast_error_std.csv"
TRAIN_PY = PROJECT_ROOT / "train.py"

# Both generators are run with the project root as the working directory:
# generate_data.py writes to a relative "data/raw/sales.csv".
GENERATORS = (
    ("seed sales data", Path(__file__).resolve().parent / "generate_data.py", SALES_CSV),
    (
        "seed inventory snapshot",
        Path(__file__).resolve().parent / "generate_inventory.py",
        INVENTORY_CSV,
    ),
)


def _report() -> None:
    print("\nLocal artifacts:")
    for label, path in (
        ("sales data", SALES_CSV),
        ("inventory snapshot", INVENTORY_CSV),
        ("trained model", MODEL_PATH),
        ("forecast error std", ERROR_STD_PATH),
    ):
        state = "present" if path.exists() else "MISSING"
        print(f"  {state:<8} {label:<20} {path.relative_to(PROJECT_ROOT)}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--force",
        action="store_true",
        help="rebuild every artifact even if it already exists",
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="report which artifacts exist and exit without changing anything",
    )
    args = parser.parse_args(argv)

    if args.status:
        _report()
        missing = [
            path
            for path in (SALES_CSV, INVENTORY_CSV, MODEL_PATH)
            if not path.exists()
        ]
        return 1 if missing else 0

    for path in (SALES_CSV, INVENTORY_CSV, MODEL_PATH):
        (path.parent).mkdir(parents=True, exist_ok=True)

    for label, script, output in GENERATORS:
        if output.exists() and not args.force:
            print(f"[skip] {label}: {output.relative_to(PROJECT_ROOT)} already exists")
            continue
        if not script.exists():
            print(f"error: generator missing: {script}", file=sys.stderr)
            return 1
        print(f"[run ] {label}: {script.relative_to(PROJECT_ROOT)}")
        # runpy, not subprocess: these are scripts, not importable modules, and
        # a traceback here should abort the whole setup rather than be swallowed.
        runpy.run_path(str(script), run_name="__main__")

    if MODEL_PATH.exists() and not args.force:
        print(f"[skip] train model: {MODEL_PATH.relative_to(PROJECT_ROOT)} already exists")
    else:
        print("[run ] train model: train.py")
        result = subprocess.run(
            [sys.executable, str(TRAIN_PY)], cwd=str(PROJECT_ROOT)
        )
        if result.returncode != 0:
            print("error: training failed", file=sys.stderr)
            return result.returncode

    _report()
    print("\nSetup complete. Start the backend with:")
    print("    .\\.venv\\Scripts\\uvicorn.exe backend.main:app --reload --port 8000")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
