#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# flake8: noqa
# pylint: disable=broad-exception-raised, raise-missing-from, too-many-arguments, redefined-outer-name
# pylint: disable=multiple-statements, logging-fstring-interpolation, trailing-whitespace, line-too-long
# pylint: disable=broad-exception-caught, missing-function-docstring, missing-class-docstring
# pylint: disable=f-string-without-interpolation, wrong-import-position, invalid-name

import os
import base64
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
# The base class of `fastapi.HTTPException`, needed by the pass-through `except` in
# generate_pdf — see the comment there.
from starlette.exceptions import HTTPException as StarletteHTTPException

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
_static_dir = os.path.join(BASE_DIR, "static")

logger = logging.getLogger("label_maker.pdf")
# Deliberately no `setLevel` and no handler here. Nothing in this repo calls
# `basicConfig`/`dictConfig`, and main.py runs uvicorn with its default logging config,
# which configures only the `uvicorn*` loggers and leaves the root one untouched — so
# records from this logger end up at `logging.lastResort`: stderr, WARNING and above,
# no formatting. That is exactly why `logger.warning(...)` and `logger.exception(...)`
# below DO appear in `docker logs` (the error reporting in generate_pdf relies on it),
# and why a future `logger.info(...)` would vanish without a trace. A
# `setLevel(logging.INFO)` used to sit here implying the opposite: it lowers this
# logger's own threshold but not lastResort's, so it never made an INFO record visible.
# Making INFO actually work means configuring handlers for the app, which is a bigger
# decision than this line should make.

PDF_API_ENABLED = os.getenv("ENABLE_PDF_API", "").strip() not in ("", "0")

_playwright = None
_browser = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _playwright, _browser
    if PDF_API_ENABLED:
        from playwright.async_api import async_playwright
        _playwright = await async_playwright().start()
        _browser = await _playwright.chromium.launch()
    yield
    if _browser:
        await _browser.close()
    if _playwright:
        await _playwright.stop()


app = FastAPI(
    title="Label Maker",
    description="Label Maker static file server",
    version="1.0.0",
    lifespan=lifespan
)

if PDF_API_ENABLED:
    from pydantic import BaseModel
    from typing import Any

    class GeneratePdfRequest(BaseModel):
        template: dict[str, Any]
        rows: list[dict[str, Any]]
        rotate: bool = False

    @app.post("/api/generate-pdf")
    async def generate_pdf(req: GeneratePdfRequest):
        if not _browser:
            raise HTTPException(status_code=503, detail="Browser not ready")

        render_url = "http://localhost:" + str(os.getenv("PORT", "8000")) + "/render.html"

        page = await _browser.new_page()

        # The renderer loads template images with crossOrigin='anonymous' (required so the
        # Konva canvas stays untainted for toDataURL). Third-party hosts that omit an
        # Access-Control-Allow-Origin header therefore fail to load in headless Chrome and the
        # label renders blank. Proxy image requests through Playwright's network stack (not
        # subject to browser CORS) and re-serve them with a permissive ACAO header so the
        # crossOrigin load succeeds without tainting the canvas. No client-side change needed.
        async def _proxy_images(route):
            request = route.request
            if request.resource_type != "image":
                await route.continue_()
                return
            try:
                resp = await route.fetch()
                body = await resp.body()
                await route.fulfill(
                    status=resp.status,
                    body=body,
                    headers={
                        "content-type": resp.headers.get("content-type", "application/octet-stream"),
                        "access-control-allow-origin": "*",
                        "cache-control": resp.headers.get("cache-control", "no-store"),
                    },
                )
            except Exception as exc:
                logger.warning("PDF render: image proxy failed for %s :: %s", request.url, exc)
                await route.continue_()

        await page.route("**/*", _proxy_images)

        # Keep lightweight diagnostics: these only fire when something actually goes wrong.
        page.on("requestfailed", lambda r: logger.warning(
            "PDF render: request FAILED %s %s :: %s", r.method, r.url, r.failure))
        page.on("pageerror", lambda exc: logger.warning("PDF render: pageerror %s", exc))

        try:
            await page.goto(render_url, wait_until="networkidle")
            await page.wait_for_function("() => window.__rendererReady === true", timeout=15000)

            data_uri = await page.evaluate(
                "(args) => window.renderPdf(args.template, args.rows, args.rotate)",
                {"template": req.template, "rows": req.rows, "rotate": req.rotate}
            )

            _, b64 = data_uri.split(",", 1)
            pdf_bytes = base64.b64decode(b64)

            return Response(
                content=pdf_bytes,
                media_type="application/pdf",
                headers={"Content-Disposition": "attachment; filename=labels.pdf"},
            )
        except StarletteHTTPException:
            # Already carries a deliberate status and a detail written for the caller;
            # re-wrapping it as a 500 below would throw both away. Nothing inside the
            # block raises one today — this branch keeps that true if one ever appears.
            # Caught on the STARLETTE class rather than fastapi's: `fastapi.HTTPException`
            # is a subclass of it, so this single `except` covers both flavours. Catching
            # only fastapi's would let a Starlette-raised one — from a dependency, or from
            # code that imported the base class — fall through to the generic handler
            # below and reach the caller re-wrapped as a 500, which is precisely what this
            # branch promises will not happen.
            raise
        except Exception as exc:
            # Why this exists at all: letting the exception propagate to Starlette gets
            # the caller a bare `Internal Server Error` with no detail (the app runs with
            # debug off), and the caller here is the Telegram print bot, which shows the
            # response body to a human. During the CDN blackhole incident that human saw
            # exactly `Label Maker returned 500: Internal Server Error` while the real
            # cause — a `Page.goto` timeout waiting for a jsPDF script that never arrived
            # because cdnjs.cloudflare.com was unreachable — was visible only to whoever
            # could read the container logs. So: log the full traceback for the container
            # log, and put the exception type and message into the response so the person
            # reading the bot's reply learns what actually broke. Capped at 500 chars
            # because a playwright error message can carry a whole page of context — a
            # message plus its "Call log" tail goes well past that. The cap ADDS a `...`
            # marker, and only when it actually cut something: without it the reader of
            # the bot's reply has no way to tell a complete error from a half sentence
            # that merely reads like one.
            logger.exception("PDF render failed: %s", exc)
            detail = f"{type(exc).__name__}: {exc}"
            if len(detail) > 500:
                detail = detail[:497] + "..."
            raise HTTPException(status_code=500, detail=detail)
        finally:
            # A raise from `page.close()` would REPLACE the exception on its way out of
            # this handler — including the HTTPException just built above, turning the
            # detailed 500 back into a bare `Internal Server Error`. Playwright suppresses
            # "safe close" errors, not every error, so a crashed or hung browser — exactly
            # the scenario this handler exists to report — can still raise here. The
            # traceback is already in the log by then, so only the response would be lost:
            # log the close failure and let the prepared response stand.
            try:
                await page.close()
            except Exception as close_exc:
                logger.warning("PDF render: page.close() failed: %s", close_exc, exc_info=True)

# Serve static files; html=True makes StaticFiles serve index.html for "/" automatically
if os.path.isdir(_static_dir):
    app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")
