#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# flake8: noqa
# pylint: disable=broad-exception-raised, raise-missing-from, too-many-arguments, redefined-outer-name
# pylint: disable=multiple-statements, logging-fstring-interpolation, trailing-whitespace, line-too-long
# pylint: disable=broad-exception-caught, missing-function-docstring, missing-class-docstring
# pylint: disable=f-string-without-interpolation, wrong-import-position, invalid-name

import os
import base64
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

BASE_DIR = os.path.dirname(os.path.dirname(__file__))
_static_dir = os.path.join(BASE_DIR, "static")

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
        finally:
            await page.close()

# Serve static files; html=True makes StaticFiles serve index.html for "/" automatically
if os.path.isdir(_static_dir):
    app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")
