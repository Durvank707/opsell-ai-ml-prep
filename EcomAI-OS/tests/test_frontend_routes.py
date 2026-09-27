"""The frontend's route table must not lock a signed-in user out of a reset.

A Supabase password-recovery link carries its credential in the URL fragment and
is routinely opened in a browser that already holds a session -- the user asked
for the reset from another device, or is signed in on the same machine. When
``/reset-password`` sat inside the guest-only group, ``GuestRoute`` redirected
those users to ``/app`` and React Router dropped the ``#access_token`` fragment on
the way, so ``ResetPasswordPage`` never saw the credential: the link looked like
it did nothing and the password could not be changed at all.

The project has no JavaScript test runner, so these assertions read the route
table out of the source. They are deliberately narrow: they pin which guard owns
each auth path, which is the part a routing change can silently break.
"""

import re
from pathlib import Path

import pytest

APP_JSX = Path(__file__).resolve().parents[1] / "frontend" / "src" / "App.jsx"


def _routes_under(source: str, guard: str) -> set[str]:
    """Paths declared *directly* inside the ``<Route element={<guard />} />`` group.

    Groups nest (``ProtectedRoute`` wraps an ``/app`` group with its own
    children), so the indent is what distinguishes a direct child from a
    grandchild and the group's own closing tag from an inner one.
    """
    opener = f"<Route element={{<{guard} />}}>"
    lines = source.split("\n")
    start = next(i for i, line in enumerate(lines) if opener in line)
    indent = len(lines[start]) - len(lines[start].lstrip())
    paths: set[str] = set()
    for line in lines[start + 1 :]:
        if line.strip().startswith("</Route>"):
            if len(line) - len(line.lstrip()) == indent:
                return paths
            continue  # the closing tag of a group nested inside this one
        if len(line) - len(line.lstrip()) != indent + 2:
            continue
        found = re.search(r'<Route path="([^"]+)"', line)
        if found:
            paths.add(found.group(1))
    pytest.fail(f"no closing tag found for the {guard} group")


@pytest.fixture(scope="module")
def app_source() -> str:
    assert APP_JSX.exists(), f"route table not found at {APP_JSX}"
    return APP_JSX.read_text(encoding="utf-8")


def test_reset_password_is_not_behind_the_guest_guard(app_source: str) -> None:
    # A recovery link is the credential; a session must not be able to discard it.
    assert "/reset-password" not in _routes_under(app_source, "GuestRoute")


def test_reset_password_has_a_guard_that_ignores_the_session(app_source: str) -> None:
    recoverable = _routes_under(app_source, "RecoverableRoute")
    assert "/reset-password" in recoverable
    # A guard that only renders an outlet cannot redirect on the session state.
    guard = re.search(
        r"function RecoverableRoute\(\) \{(.*?)\n\}", app_source, re.DOTALL
    )
    assert guard, "RecoverableRoute is not defined"
    assert "Navigate" not in guard.group(1)
    assert "useAuth" not in guard.group(1)


def test_the_sign_in_pages_remain_guest_only(app_source: str) -> None:
    # Signing in again is meaningless once you have a session, so these keep the
    # redirect; only the reset page had to move.
    guest = _routes_under(app_source, "GuestRoute")
    assert {"/login", "/signup", "/forgot-password"} <= guest


def test_every_app_page_is_still_behind_the_session(app_source: str) -> None:
    # The move must not have relaxed anything under /app.
    protected = _routes_under(app_source, "ProtectedRoute")
    assert "/app" in protected
    assert "/reset-password" not in protected
