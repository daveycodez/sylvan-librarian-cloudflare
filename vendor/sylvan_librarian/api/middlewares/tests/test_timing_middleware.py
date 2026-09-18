"""Tests for TimingMiddleware's handling of the request it logs."""

from __future__ import annotations

import gzip

import falcon
import falcon.testing

from api.middlewares.compression.compression_mod import CompressionMiddleware
from api.middlewares.timing import TimingMiddleware

# Comfortably over CompressionMiddleware's MIN_SIZE, so the compressed stack below really compresses
# instead of taking the short-response bail-out and leaving the interaction untested.
PADDING = "x" * 500


class _Padded:
    """A route whose body is big enough to be worth compressing."""

    def on_get(self, req: falcon.Request, resp: falcon.Response) -> None:
        del req
        resp.media = {"pad": PADDING}


def _app(*downstream: object) -> falcon.App:
    """An app with TimingMiddleware first, so its process_response runs last as it does in get_api."""
    app = falcon.App(middleware=[TimingMiddleware(), *downstream])
    app.add_route("/x", _Padded())
    return app


def _get(
    app: falcon.App,
    *,
    user_agent: str | None,
    accept_encoding: str | None = None,
) -> tuple[str, dict[str, str], bytes]:
    """GET /x, with the User-Agent header genuinely absent when `user_agent` is None.

    `simulate_get` cannot express "no User-Agent": `falcon.testing.create_environ` injects a default
    one whenever the caller does not name it, so the header has to be deleted from the environ.

    Args:
        app: The app to call as a WSGI callable.
        user_agent: User-Agent to send, or None to send no such header at all.
        accept_encoding: Accept-Encoding to send, or None to send no such header.

    Returns:
        The response status, its headers lowercased by name, and the raw body bytes.
    """
    headers = {} if accept_encoding is None else {"Accept-Encoding": accept_encoding}
    env = falcon.testing.create_environ(path="/x", headers=headers)
    if user_agent is None:
        del env["HTTP_USER_AGENT"]
    else:
        env["HTTP_USER_AGENT"] = user_agent
    start_response = falcon.testing.StartResponseMock()
    body = b"".join(app(env, start_response))
    return start_response.status, {name.lower(): value for name, value in start_response.headers}, body


class TestMissingUserAgent:
    """The timing line logs the User-Agent; a request without one must still be an ordinary request.

    `req.get_header("User-Agent", "-")` passed `"-"` as `required`, not `default`, so the missing
    header raised HTTPMissingHeader from process_response -- a 400 on every route.
    """

    def test_request_without_user_agent_is_200(self) -> None:
        status, headers, body = _get(_app(), user_agent=None)
        assert status == falcon.HTTP_200, body
        # `in`, not startswith: with a downstream middleware recording spans, "total" is not first.
        assert "total;dur=" in headers["server-timing"], headers["server-timing"]

    def test_request_with_user_agent_is_200(self) -> None:
        status, _headers, body = _get(_app(), user_agent="probe/1.0")
        assert status == falcon.HTTP_200, body

    def test_response_stays_decodable_behind_compression(self) -> None:
        """The client-visible damage, not just the status code.

        TimingMiddleware is first in `get_api`'s list, so its process_response runs *after*
        CompressionMiddleware has replaced the body and set Content-Encoding. Falcon does not
        unwind those headers when a later process_response raises, so the 400 went out claiming
        an encoding its plain-JSON body did not have and the client could not decode it. A status
        assertion alone does not cover that, so this decompresses the body it was handed.
        """
        status, headers, body = _get(_app(CompressionMiddleware()), user_agent=None, accept_encoding="gzip")
        assert status == falcon.HTTP_200, body
        assert headers.get("content-encoding") == "gzip", headers
        assert PADDING in gzip.decompress(body).decode()
        assert "total;dur=" in headers["server-timing"], headers["server-timing"]
