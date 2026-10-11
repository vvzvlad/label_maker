"""Smoke test for the label_maker images, run against a live container.

Fed over stdin (`docker exec -e EXPECT_PDF_API=0|1 -i <name> python - < ci/smoke.py`), so it
is not copied into the image and can be run by hand against a local container. Pure stdlib:
the plain image has only fastapi, uvicorn and pydantic.

One script covers both images. `Dockerfile.backend` is the same app plus playwright/chromium
and `ENV ENABLE_PDF_API=1`; the only behavioural difference is whether
`POST /api/generate-pdf` exists, selected by EXPECT_PDF_API.

* It talks HTTP to the server started by the image's own CMD rather than importing src.api,
  so it proves the container comes up.
* Failures leave through SystemExit, never `assert`, which PYTHONOPTIMIZE=1 strips.
* Konva, QRious and jsPDF are vendored in static/vendor/ and served from /vendor/ (see
  docs/vendored-libs.md). The guards below reject any external `<script src>`, `<link href>`
  or `import ... from 'https://...'` in render.html or under /modules/: chromium waits for
  `networkidle`, so an unreachable CDN hangs every render into an HTTP 500. A positive check
  asserts the three /vendor/ files are referenced.

  The guards match broadly: a quoted URL counts anywhere in the body, comments and `<a href>`
  included, because position-aware exemptions can lose sync and exempt a real reference. On
  a false red, move the URL out of the file or reword the comment. Adding the whole URL to
  NEVER_FETCHED_URL_NAMES helps only check_no_external_urls; check_no_cdn_libs never reads it.

  Known limits: a URL split across a concatenation, a JSON-escaped URL and a CDN URL that
  never names the library are invisible. An unquoted URL in prose matches nothing, but an
  unquoted `src=`/`href=` spelled out in a comment fires check_no_cdn_libs (a false red).
  This is a regression guard, not a proof of hermeticity.

  The application itself can still touch the network: an image node with `isUrl: true`
  makes render.html load an arbitrary URL, and `loadImageFromUrl` in
  static/modules/utils.js sets no timeout. The smoke payload is text only.

For the backend image there is no separate chromium probe: src/api.py launches chromium in
the FastAPI `lifespan` hook, so a browser that cannot start makes uvicorn exit and the
workflow's readiness loop sees an exited container.

Every target is checked before reporting, so one run shows the full extent of the breakage.
"""

import json
import os
import posixpath
import re
import urllib.error
import urllib.request

# main.py reads PORT from the environment and defaults to 8000; neither Dockerfile
# nor the CI run sets PORT, so 8000 is what both containers listen on.
BASE_URL = "http://127.0.0.1:8000"
TIMEOUT = 5

# src/api.py mounts static/ at "/" with html=True, so "/" is static/index.html. Status
# alone does not catch a truncated index.html, so three structural ids, one per area of the
# page: the data table (top), the generate button (middle), the Konva canvas (bottom). Ids
# rather than classes or UI copy because they do not change with styling or wording, and
# the JS looks each of them up, so renaming one breaks the app visibly.
#
# The three vendor script tags are the positive half of the vendoring guard: without them
# the plain image would pass with a blank editor.
VENDOR_SCRIPT_MARKERS = [
    'src="/vendor/jspdf.umd.min.js"',
    'src="/vendor/konva.min.js"',
    'src="/vendor/qrious.min.js"',
]

HTML_ROUTES = [
    ("/", ['id="entities-tbody"', 'id="btn-generate"', 'id="konva-container"']
          + VENDOR_SCRIPT_MARKERS),
]

# Served by StaticFiles from inside the image, so a broken `COPY static/` shows up here.
# /render.html is the page the backend image loads in headless chromium to produce a PDF.
STATIC_ASSETS = [
    "/style.css",
    "/app.js",
    "/render.html",
]

# The vendored libraries. A size floor (a little over a quarter of the real size) catches a
# truncated download or an error page saved under a .js name without pinning a byte count;
# exact sizes and SHA-256 sums live in docs/vendored-libs.md.
#
# The marker identifies the library. For konva and qrious it is the preamble banner, which
# does not distinguish the UMD build from the ESM one. For jsPDF, `jspdf={}` is the UMD
# wrapper's assignment that creates `window.jspdf`, which render.html calls; the ESM bundle
# (`jspdf.es.min.js`) contains "jsPDF" but not this string.
VENDOR_ASSETS = [
    ("/vendor/konva.min.js", 50000, "Konva JavaScript Framework"),
    ("/vendor/qrious.min.js", 5000, "QRious"),
    ("/vendor/jspdf.umd.min.js", 100000, "jspdf={}"),
]

# A <script src> or <link href> pointing at another host (absolute or protocol-relative),
# quoted or unquoted. Everything render.html loads is same-origin. An external stylesheet
# blocks `networkidle` like a script does. On render.html this overlaps EXTERNAL_URL_RE but
# names the failure precisely and also reads unquoted attributes.
#
# `(?<![\w-])` instead of `\b` so that `data-src=`, which loads nothing, does not match.
EXTERNAL_REF_RE = re.compile(
    r"""<(?:script|link)\b[^>]*?(?<![\w-])(?:src|href)\s*=\s*"""
    r"""(?:["']((?:https?:)?//[^"']*)["']|((?:https?:)?//[^\s"'>]+))""", re.I)

# An external URL naming one of the three vendored libraries, from any host. index.html
# legitimately loads Bootstrap, its icon font and rybbit from external hosts, so on "/" and
# /app.js this narrow guard is the only one that fits.
#
# The name is matched in any string literal (single, double, backtick) and in an unquoted
# HTML attribute value, regardless of syntax: import maps, indirect `import(U)`,
# `setAttribute('src', ...)` and template literals all fetch from a CDN without being a
# `src` assignment. Nothing is exempted by position, so a credits link naming one of the
# libraries also fires; put such a URL somewhere this guard does not read.
#
# Two alternatives:
#   1. the URL inside a string literal; quoted HTML attributes are covered by this arm.
#   2. an unquoted attribute value (`src=//host/konva.js`), without EXTERNAL_REF_RE's
#      lookbehind, so `data-src=//cdn.../konva.min.js` also fires.
#
# Both arms require `//` or `https?://`, so same-origin `/vendor/...` and `./modules/...`
# cannot match. Limits: the library name must appear after `//` inside one string literal.
CDN_LIB_RE = re.compile(
    r"""["'`]((?:https?:)?//[^"'`]*(?:konva|qrious|jspdf)[^"'`]*)["'`]"""
    r"""|(?:src|href)\s*=\s*"""
    r"""((?:https?:)?//[^\s"'`>]*(?:konva|qrious|jspdf)[^\s"'`>]*)""",
    re.I)

# An external URL anywhere in a body, tag or no tag: `import ... from 'https://...'`,
# `import('https://...')`, `fetch(...)`, `el.src = ...`. Applied only to /modules/ bodies
# and /render.html; "/" and /app.js get check_no_cdn_libs instead, since the public UI
# legitimately references external hosts.
#
# The URL must sit inside a string literal (a quote or backtick on both sides); the
# protocol-relative arm also requires a dotted host. Unquoted URLs in comments do not
# match, quoted ones do (including backtick-quoted); reword such a comment rather than
# teaching the scan to skip comments, since a comment scanner can be fooled by the `//`
# inside URLs. The only exemption is NEVER_FETCHED_URL_NAMES, by exact value.
#
# re.I because URL schemes are case-insensitive (RFC 3986).
#
# Cannot see a URL computed from fragments or escaped inside its literal; an unquoted URL in
# an HTML attribute is covered by EXTERNAL_REF_RE for /render.html.
EXTERNAL_URL_RE = re.compile(
    r"""["'`](https?://[^\s"'`>]+)["'`]"""
    r"""|["'`](//[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+[^\s"'`>]*)["'`]""", re.I)

# XML namespace names, which are identifiers spelled as URIs and never fetched
# (`createElementNS('http://www.w3.org/2000/svg', ...)`, `xmlns` in an SVG data URI). Dropped
# from the check_no_external_urls result by exact match on the lowercased URL, so a subtree
# like `.../1999/xhtml/vocab` is not exempt. Entries must be full identifiers in lowercase.
# Protocol-relative and `https://` spellings are not valid namespace names and are left out
# so the gate reds on them. Case-folding means a wrong-case namespace typo is forgiven.
NEVER_FETCHED_URL_NAMES = frozenset((
    "http://www.w3.org/2000/svg",
    "http://www.w3.org/1999/xlink",
    "http://www.w3.org/1999/xhtml",
    "http://www.w3.org/xml/1998/namespace",
    "http://www.w3.org/2000/xmlns/",
))

# The ES module graph is discovered from the two entry points, not hardcoded, and walked
# transitively: modules import each other relatively, so a module reachable only through
# another module would otherwise go unchecked.
MODULE_SOURCES = ["/app.js", "/render.html"]

# Only references resolving under this prefix are followed. A relative import resolving
# outside /modules/ (e.g. `../lib/shared.js`) would go unchecked; widen this if the layout
# grows a second directory.
MODULE_DIR = "/modules/"

# Anchored to a real `from '<relative path>.js'` clause, so a module mentioned in prose or a
# string does not match. Both quote styles, `./` and `../`. A commented-out import still
# matches (a false red; delete the line). Side-effect `import './x.js';` and dynamic
# `import('./x.js')` are not matched; static/ uses neither.
MODULE_REF_RE = re.compile(r"""from\s+['"](\.{1,2}/[A-Za-z0-9_./-]+\.js)['"]""")

# Present only when ENABLE_PDF_API is set, which Dockerfile.backend does and
# Dockerfile does not.
PDF_API_ROUTE = "/api/generate-pdf"

# The smallest label that exercises the whole pipeline: src/api.py drives headless chromium
# to /render.html, waits for networkidle and calls window.renderPdf(); Konva builds the
# stage and jsPDF emits the document, so a missing /vendor/ file fails this. The `%E1%`
# placeholder is substituted from the row's entities, proving the module graph executed.
PDF_RENDER_PAYLOAD = {
    "template": {"version": 1, "widthMm": 58, "heightMm": 40, "nodes": [
        {"type": "text", "text": "SMOKE %E1%", "x": 10, "y": 10, "rotation": 0,
         "scaleX": 1, "scaleY": 1, "fontSize": 24, "fill": "#000000",
         "width": 180, "height": 60, "align": "center", "verticalAlign": "middle"}]},
    "rows": [{"entities": ["OK"]}],
    "rotate": False,
}

# Far above TIMEOUT: a warm render takes about 1.5 s, but this is the first page chromium
# opens in a fresh container on a slower CI runner. A timeout here means a real hang.
PDF_RENDER_TIMEOUT = 60

# A one-label PDF runs to megabytes (rasterised at 600 DPI); a valid but empty jsPDF
# document is a few hundred bytes, which is what this floor excludes.
PDF_MIN_BYTES = 10 * 1024


def fetch(route):
    """GET the route; return (body_bytes, None) on 200, else (None, reason)."""
    try:
        with urllib.request.urlopen(BASE_URL + route, timeout=TIMEOUT) as response:
            status = response.status
            body = response.read()
    except urllib.error.HTTPError as error:
        # A 4xx/5xx is an answer, not a transport problem: report the code as is.
        return None, "HTTP {}".format(error.code)
    except Exception as error:
        # Connection refused, timeout, DNS — anything that kept us from an answer.
        return None, "{}: {}".format(type(error).__name__, error)
    if status != 200:
        return None, "HTTP {}".format(status)
    return body, None


def check_html(body, reason, markers):
    """Return None when the route answered 200 AND carries every marker."""
    if reason is not None:
        return reason
    try:
        # Decoded explicitly as UTF-8 rather than compared as bytes: the page is
        # Russian, so matching a str marker against a bytes body would be a
        # guaranteed false failure.
        text = body.decode("utf-8")
    except UnicodeDecodeError as error:
        return "200 but body is not valid UTF-8: {}".format(error)
    # EVERY missing marker is reported, not just the first one: which ones are gone
    # is the diagnosis — a truncated file loses the tail markers, a wrecked one loses
    # all of them.
    missing = [marker for marker in markers if marker not in text]
    if missing:
        return "200 but {}/{} markers missing from {} bytes of body: {}".format(
            len(missing), len(markers), len(body),
            ", ".join(repr(marker) for marker in missing))
    return None


def check_asset(body, reason):
    """Return None when the asset answered 200 with a non-empty body."""
    if reason is not None:
        return reason
    # A style.css or app.js truncated to zero bytes still answers 200.
    if not body:
        return "200 but the body is empty (0 bytes)"
    return None


def check_vendor_asset(body, reason, minimum, marker):
    """Return None when the vendored library is both big enough AND the right library."""
    problem = check_asset(body, reason)
    if problem is not None:
        return problem
    # Size and identity are separate diagnoses (truncated vs swapped file); both are
    # listed when both apply.
    problems = []
    if len(body) < minimum:
        problems.append("only {} bytes, below the {} byte floor — that is not the "
                        "library: a truncated copy, a placeholder, or an error page "
                        "saved under a .js name".format(len(body), minimum))
    if marker.encode("utf-8") not in body:
        problems.append("the marker {!r} is missing from {} bytes of body — this is not "
                        "that library, or (for jspdf.umd.min.js) not the UMD build: a "
                        "swapped file, a wrongly copied one, or an ESM bundle picked up "
                        "during a refresh (see docs/vendored-libs.md)".format(
                            marker, len(body)))
    if problems:
        return "200 but " + "; ".join(problems)
    return None


def html_text(body):
    """Decode a fetched page for scanning; None when there is nothing to scan."""
    # A None body is already reported as a failed fetch; callers turn it into an explicit
    # "not checked" rather than a green ok.
    if body is None:
        return None
    return body.decode("utf-8", "replace")


def matched_urls(pattern, text):
    """Every non-empty capture group of `pattern` in `text`, in order, deduplicated.

    The patterns are alternations, so exactly one group is filled per match. Where in the
    text a match sits is not considered; the only exemptions are by URL value.
    """
    found = []
    for match in pattern.finditer(text):
        for value in match.groups():
            if value and value not in found:
                found.append(value)
    return found


def check_no_external_refs(body):
    """Return None when the page loads no script and no stylesheet from another host."""
    text = html_text(body)
    if text is None:
        return "not checked: the page did not load (its own failure is reported above)"
    external = matched_urls(EXTERNAL_REF_RE, text)
    if external:
        # Every offending URL is listed, not just the first: a change that re-adds one
        # library usually re-adds all three, and seeing them together is the diagnosis.
        return ("{} external <script src>/<link href> back in the page — the renderer "
                "must load nothing from a third-party host (vendor it into "
                "static/vendor/ instead): {}".format(
                    len(external), ", ".join(repr(url) for url in external)))
    return None


def check_no_external_urls(body):
    """Return None when the body names no external URL at all, in any syntax."""
    text = html_text(body)
    if text is None:
        return "not checked: the body did not load (its own failure is reported above)"
    # The one exemption, by exact value after the match; lowercased because the entries
    # are lowercase.
    external = [url for url in matched_urls(EXTERNAL_URL_RE, text)
                if url.lower() not in NEVER_FETCHED_URL_NAMES]
    if external:
        return ("{} external URL(s) in the body — render.html and the modules under "
                "/modules/ must reference no third-party host in any form (a `<link>`, "
                "an `import … from 'https://…'`, a fetch): {}".format(
                    len(external), ", ".join(repr(url) for url in external)))
    return None


def check_vendor_refs(body):
    """Return None when the page really references all three /vendor/ libraries."""
    text = html_text(body)
    if text is None:
        return "not checked: the page did not load (its own failure is reported above)"
    # The positive half of the vendoring guard: the negative checks say nothing about a
    # missing reference, and on the plain image nothing else would catch it.
    missing = [marker for marker in VENDOR_SCRIPT_MARKERS if marker not in text]
    if missing:
        # The page is named by the result label, hence no `label` argument.
        return ("200 but {}/{} vendored libraries are not referenced by the page at all "
                "— it would load without them: {}".format(
                    len(missing), len(VENDOR_SCRIPT_MARKERS),
                    ", ".join(repr(marker) for marker in missing)))
    return None


def check_no_cdn_libs(body):
    """Return None when the body names no external URL for any of the three libraries."""
    text = html_text(body)
    if text is None:
        return "not checked: the page did not load (its own failure is reported above)"
    cdn_libs = matched_urls(CDN_LIB_RE, text)
    if cdn_libs:
        # Counted in URLs, not libraries: two CDN spellings of konva are two entries.
        return ("{} external URL(s) naming a vendored library — konva, qrious and jspdf "
                "must come from /vendor/, never over the network: {}".format(
                    len(cdn_libs), ", ".join(repr(url) for url in cdn_libs)))
    return None


def check_pdf_render():
    """Return None when POST to the PDF API really produced a PDF."""
    request = urllib.request.Request(
        BASE_URL + PDF_API_ROUTE,
        data=json.dumps(PDF_RENDER_PAYLOAD).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=PDF_RENDER_TIMEOUT) as response:
            status = response.status
            content_type = response.headers.get("Content-Type", "")
            body = response.read()
    except urllib.error.HTTPError as error:
        # The detail names the real cause only because generate_pdf in src/api.py catches
        # the exception and re-raises an HTTPException with "<ExceptionType>: <message>";
        # a bare `Internal Server Error` here means that handler is missing.
        #
        # The cap is well above the 500 characters api.py truncates its detail to, so the
        # JSON closing and api.py's trailing `...` survive. `errors="replace"` covers a cut
        # through a multi-byte character on a longer body.
        detail = error.read()[:2000].decode("utf-8", "replace")
        return "HTTP {}: {}".format(error.code, detail)
    except Exception as error:
        return "{}: {}".format(type(error).__name__, error)

    # Three independent ways for this to be wrong, all reported together: a non-PDF
    # content type, a body that is not a PDF, and a PDF with nothing in it.
    problems = []
    if status != 200:
        problems.append("HTTP {}".format(status))
    if not content_type.lower().startswith("application/pdf"):
        problems.append("content-type is {!r}, not application/pdf".format(content_type))
    # Only the first bytes are ever printed: the body is several megabytes.
    if not body.startswith(b"%PDF-"):
        problems.append("body does not start with %PDF- (starts with {!r})".format(
            body[:8]))
    if len(body) <= PDF_MIN_BYTES:
        problems.append("body is only {} bytes, at or below the {} byte floor — the "
                        "render produced an empty document".format(
                            len(body), PDF_MIN_BYTES))
    if problems:
        return "; ".join(problems)
    return None


def module_refs(route, body):
    """Module routes imported by `body`, resolved against `route`'s own directory."""
    # Resolved relative to the importing file: /app.js writes `./modules/state.js`,
    # /modules/pdf.js writes `./state.js` for the same file.
    base = posixpath.dirname(route)
    targets = []
    for spec in MODULE_REF_RE.findall(body.decode("utf-8", "replace")):
        target = posixpath.normpath(posixpath.join(base, spec))
        if target.startswith(MODULE_DIR) and target not in targets:
            targets.append(target)
    return targets


def check_modules(bodies):
    """Walk the module graph from the entry points; return a list of (label, reason)."""
    seeds = []
    readable = []
    for route in MODULE_SOURCES:
        body = bodies.get(route)
        if body is None:
            # Its own fetch failure is already reported as a failed target above;
            # do not report the same transport problem twice, just note what could
            # not be scanned.
            continue
        readable.append(route)
        for target in module_refs(route, body):
            if target not in seeds:
                seeds.append(target)

    if not seeds:
        # Fail loudly rather than check nothing: either the entry points did not load or
        # the import style changed (bare specifiers, an import map, a bundler).
        return [("module discovery", "no relative `from './...js'` module imports "
                 "found in {} (readable sources: {}) — the import style changed, or "
                 "the entry points did not load".format(
                     ", ".join(MODULE_SOURCES),
                     ", ".join(readable) if readable else "none"))]

    # Breadth-first. `visited` is both the dedupe and the cycle guard: ES modules may
    # import each other in a loop.
    visited = set()
    queue = list(seeds)
    walked = []
    while queue:
        route = queue.pop(0)
        if route in visited:
            continue
        visited.add(route)
        body, reason = fetch(route)
        problem = check_asset(body, reason)
        if problem is not None:
            # Reported like any other broken target; the walk continues with the rest of
            # the queue, only this module's imports are unknown.
            walked.append((route, problem))
            continue
        # Scanned here because the body is already in hand. The walk descends into the
        # imports regardless of the result, so one bad module does not hide its subtree.
        walked.append((route, check_no_external_urls(body)))
        for target in module_refs(route, body):
            if target not in visited:
                queue.append(target)

    # The count is printed so a green log shows whether discovery degraded.
    results = [("module discovery -> {} modules reachable from {} ({} imported "
                "directly by the entry points)".format(
                    len(walked), ", ".join(readable), len(seeds)), None)]
    results.extend(sorted(walked, key=lambda item: item[0]))
    return results


def check_pdf_api(expect_present):
    """Return None when the PDF API's presence matches what this image should have."""
    request = urllib.request.Request(
        BASE_URL + PDF_API_ROUTE,
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        # Expected on both images: an answer, not a transport problem.
        status = error.code
    except Exception as error:
        return "POST got no answer at all: {}: {}".format(type(error).__name__, error)

    # Checks whether the route exists, not an exact status: with the route registered an
    # empty body gives 422, or 503 if the browser died. Without it, StaticFiles mounted at
    # "/" rejects a POST with 405.
    route_missing = status in (404, 405)

    if expect_present and route_missing:
        return ("EXPECT_PDF_API=1 but POST answered HTTP {} — the route is not "
                "registered: ENABLE_PDF_API did not reach the app (a lost `ENV` in "
                "Dockerfile.backend, or the plain image built under the backend "
                "image's name)".format(status))
    if not expect_present and not route_missing:
        return ("EXPECT_PDF_API=0 but POST answered HTTP {} — the route IS "
                "registered: the PDF API leaked into the image that must not have "
                "it (ENABLE_PDF_API set somewhere it should not be, or the backend "
                "image built under the plain image's name)".format(status))
    return None


def read_expectation():
    """Read EXPECT_PDF_API; refuse to run on anything but an explicit "0" or "1"."""
    # No default: the two matrix legs would become indistinguishable if the workflow
    # forgot to pass the variable.
    raw = os.environ.get("EXPECT_PDF_API")
    if raw not in ("0", "1"):
        print('smoke FAILED: EXPECT_PDF_API must be "0" (plain label_maker image) or '
              '"1" (label_maker-backend image); got {!r}. Pass it with '
              '`docker exec -e EXPECT_PDF_API=... -i <container> python - < ci/smoke.py`.'
              .format(raw))
        raise SystemExit(1)
    return raw == "1"


def main():
    expect_pdf_api = read_expectation()

    results = []
    bodies = {}

    for route, markers in HTML_ROUTES:
        body, reason = fetch(route)
        bodies[route] = body
        results.append((route, check_html(body, reason, markers)))

    for route in STATIC_ASSETS:
        body, reason = fetch(route)
        bodies[route] = body
        results.append((route, check_asset(body, reason)))

    for route, minimum, marker in VENDOR_ASSETS:
        body, reason = fetch(route)
        results.append((route, check_vendor_asset(body, reason, minimum, marker)))

    # Reuses the bodies already fetched above — the entry points are both in
    # STATIC_ASSETS, so there is no point in asking for them twice.
    results.extend(check_modules(bodies))

    # Every guard below reads a body already fetched: "/" IS index.html (StaticFiles is
    # mounted with html=True), and /render.html and /app.js are both in STATIC_ASSETS, so
    # no page is requested a second time.
    #
    # Negative and positive halves, in that order. "/" gets its positive half for free —
    # the three /vendor/ markers are part of HTML_ROUTES above — while /render.html needs
    # its own, since it is checked as a plain asset.
    results.append(("/render.html (no external <script src>/<link href>)",
                    check_no_external_refs(bodies.get("/render.html"))))
    results.append(("/render.html (no external URL anywhere in the page)",
                    check_no_external_urls(bodies.get("/render.html"))))
    results.append(("/render.html (loads all three /vendor/ libraries)",
                    check_vendor_refs(bodies.get("/render.html"))))
    # On "/" and /app.js the library-keyed guard is the only one (the public UI references
    # external hosts). On /render.html it catches what the stricter two exclude, e.g.
    # `<script data-src=//cdn.../konva.min.js>`, ignored by EXTERNAL_REF_RE's lookbehind and
    # by EXTERNAL_URL_RE's quote requirement.
    results.append(("/render.html (konva/qrious/jspdf not from a CDN)",
                    check_no_cdn_libs(bodies.get("/render.html"))))
    results.append(("/ index.html (konva/qrious/jspdf not from a CDN)",
                    check_no_cdn_libs(bodies.get("/"))))
    # /app.js is the public UI's entry point: the module walk scans only discovered
    # /modules/ routes, not the entry points, and the broad URL scan cannot be used here.
    results.append(("/app.js (konva/qrious/jspdf not from a CDN)",
                    check_no_cdn_libs(bodies.get("/app.js"))))

    results.append(("POST " + PDF_API_ROUTE + " (EXPECT_PDF_API={})".format(
        "1" if expect_pdf_api else "0"), check_pdf_api(expect_pdf_api)))

    # Backend image only. The plain image has no route to render with — check_pdf_api
    # above already asserted it answers 404/405 — and posting a real payload at it would
    # only re-check the same 405.
    if expect_pdf_api:
        results.append(("POST " + PDF_API_ROUTE + " -> real PDF render",
                        check_pdf_render()))

    failures = []
    for target, reason in results:
        if reason is None:
            print("ok   {}".format(target))
        else:
            print("FAIL {} -> {}".format(target, reason))
            failures.append("{} ({})".format(target, reason))

    if failures:
        print("smoke FAILED: {}/{} targets broken: {}".format(
            len(failures), len(results), ", ".join(failures)))
        raise SystemExit(1)

    print("smoke ok: {}/{} targets".format(len(results), len(results)))


if __name__ == "__main__":
    main()
