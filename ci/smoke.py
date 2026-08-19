"""Smoke test for the label_maker images, run against a live container.

It is fed to the container over stdin (`docker exec -i <name> python - < ci/smoke.py`),
so it never has to be copied into the image, and it can be run by hand the same way
against any locally started container of either image.

It is pure stdlib on purpose: the plain image installs only fastapi, uvicorn and
pydantic (the backend one adds playwright), so anything else imported here would fail
at the gate instead of at the thing being gated.

ONE script covers BOTH images. They are the same application: `Dockerfile` builds the
plain `label_maker`, `Dockerfile.backend` builds `label_maker-backend`, which is the
same code plus playwright/chromium and `ENV ENABLE_PDF_API=1`. The single behavioural
difference is whether `POST /api/generate-pdf` exists, and that is driven by the
EXPECT_PDF_API environment variable read below — passed in with
`docker exec -e EXPECT_PDF_API=... -i <name> python - < ci/smoke.py`. Two separate
scripts would drift; one script with two expectations cannot.

Three properties matter here and are easy to lose:

* It talks HTTP to the server the image's own CMD started, instead of importing
  src.api in-process. Only the former proves the container actually comes up — a
  broken `__main__` block, a bad WORKDIR or a typo in CMD all pass an in-process
  check while production serves nothing.
* Failures leave through SystemExit, never `assert`. Asserts vanish under
  PYTHONOPTIMIZE=1 (a common slim-image tweak), which would silently turn this gate
  permanently green.
* The render is HERMETIC, and that is precisely why it is now checked end to end.
  Konva, QRious and jsPDF live in static/vendor/ and are loaded from /vendor/ (see
  static/vendor/README.md), so static/render.html and its whole module graph reach no
  third-party host: producing a real PDF touches nothing outside the container, and
  the backend leg below therefore renders one and inspects the bytes.
  What must never come back is an external `<script src="https://…">` in render.html.
  That is what this gate exists to prevent: the libraries used to come from
  cdn.jsdelivr.net and cdnjs.cloudflare.com, the Cloudflare addresses were blackholed
  from the production host, chromium hung forever on the jsPDF script, `networkidle`
  never fired and every print came back HTTP 500. Re-adding an external script would
  both re-break production behind a blocked CDN and put this gate at the mercy of
  someone else's uptime — red on their outage, blocking a perfectly good deploy. The
  guard below rejects any external script src in render.html.

For the backend image there is also no separate "did chromium start" probe, and none
is needed: src/api.py starts playwright and launches chromium inside the FastAPI
`lifespan` startup hook, so a browser that cannot start raises during startup and
uvicorn exits. The container dies instead of serving, the readiness loop in the
workflow sees an exited container and prints its logs. In other words, the fact that
the backend image answers HTTP at all already proves chromium launched.

Every target is checked before reporting, so one run shows the full extent of the
breakage rather than only the first broken thing.
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

# src/api.py mounts static/ at "/" with html=True, so "/" is served straight from
# static/index.html — there is no template engine and no other HTML route.
# Status alone is not enough: a truncated or half-copied index.html (a botched
# `COPY static/`, a partially written file) answers a perfectly good 200 and the
# app ships as a blank page.
#
# Hence THREE structural markers, one per functional area of the page, so a partial
# file cannot pass by having only its opening third:
#   * `id="entities-tbody"` — the data table (top of the page body)
#   * `id="btn-generate"`   — the toolbar that triggers PDF generation (middle)
#   * `id="konva-container"` — the canvas the editor draws into (bottom)
#
# They are `id` attributes rather than classes because an id holds exactly one value
# and cannot grow a second token the way a class list can: turning
# `class="btn btn-generate flex-fill"` into `class="btn btn-generate flex-fill mt-2"`
# is an everyday CSS edit that would break a `class="..."` marker on a page that
# rendered perfectly.
#
# They are attributes rather than prose because every visible string on this page is
# UI copy that gets reworded — the structure does not.
#
# All three are load-bearing, so renaming one visibly breaks the app and would not
# pass unnoticed: app.js and modules/pdf.js look up `btn-generate`,
# modules/entity-table.js and modules/presets.js look up `entities-tbody`, and
# modules/stage.js hands `konva-container` to Konva as its stage container.
HTML_ROUTES = [
    ("/", ['id="entities-tbody"', 'id="btn-generate"', 'id="konva-container"']),
]

# Served by StaticFiles from inside the image, so a broken `COPY static/` shows up
# here and nowhere else: "/" renders fine on its own while the app reaches production
# with no styling, no JavaScript at all, or with the PDF renderer's page missing.
# /render.html is the page the backend image loads in headless chromium to produce a
# PDF, so its absence breaks label_maker-backend without breaking a single HTML route.
STATIC_ASSETS = [
    "/style.css",
    "/app.js",
    "/render.html",
]

# The three libraries the renderer needs, vendored into static/vendor/ and served by the
# image itself. Checked apart from STATIC_ASSETS because "non-empty" is far too weak for
# them: what actually goes wrong with a vendored dependency is a truncated download or a
# captive-portal / error page saved under a .js name, and both answer 200 with a body of
# a few hundred bytes. A size FLOOR is the honest check — it catches every one of those
# without pinning the gate to an exact byte count, so a deliberate version bump does not
# turn it red. Each floor sits a little over a quarter of the real size (175354, 17579
# and 364463 bytes today; the exact figures are in static/vendor/README.md).
#
# Their absence is invisible everywhere else: "/" and /render.html both answer a flawless
# 200 with a missing /vendor/ directory, and the app is dead the moment a browser — or
# headless chromium in the backend image — actually loads the page.
VENDOR_ASSETS = [
    ("/vendor/konva.min.js", 50000),
    ("/vendor/qrious.min.js", 5000),
    ("/vendor/jspdf.umd.min.js", 100000),
]

# Matches a <script> whose src points at another host: an absolute http(s):// URL or the
# protocol-relative //host/… form. Everything the pages should load is same-origin and
# root-relative (`/vendor/konva.min.js`, `./modules/utils.js`), so this pattern has no
# legitimate match in render.html at all.
EXTERNAL_SCRIPT_RE = re.compile(
    r"""<script[^>]*\bsrc\s*=\s*["']((?:https?:)?//[^"']*)["']""", re.I)

# Matches a src=/href= URL that would pull one of the three VENDORED libraries from a CDN
# again — the exact regression static/vendor/ exists to prevent. Deliberately narrower
# than EXTERNAL_SCRIPT_RE because index.html legitimately keeps loading Bootstrap, the
# Bootstrap Icons font CSS and the rybbit analytics script from external hosts: only the
# three libraries were vendored, and a guard that failed on any external URL there would
# be a guard nobody could keep green. The host and the library name must appear inside the
# SAME quoted attribute value, so the bootstrap@5.3.3 URL on the very next line does not
# match.
CDN_LIB_RE = re.compile(
    r"""["']([^"']*(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com)[^"']*"""
    r"""(?:konva|qrious|jspdf)[^"']*)["']""", re.I)

# The ES module graph is discovered, never hardcoded. A literal list of
# static/modules/*.js would be a maintenance burden and would go stale the moment
# someone adds or renames a module — and a stale list is worse than no list, because
# it keeps reporting "ok" for the modules it still remembers.
# Instead the two entry points are fetched and every module reference in their bodies
# is resolved against the running server. That checks the REAL dependency graph: a
# single missing module breaks the app completely while "/" keeps answering a flawless
# 200 — the browser is the only thing that ever notices.
#
# The walk is TRANSITIVE, and that is the whole point. The modules import each other
# in exactly the same relative style (modules/pdf.js imports ./image-processing.js,
# modules/entity-table.js imports ./state.js), so a first-level-only scan would cover
# only what app.js and render.html name by hand: a module reachable ONLY through
# another module would go completely unchecked, and dropping it from `COPY static/`
# would leave every route answering 200 while the app is dead in the browser. The
# "nothing found at all" guard below does not catch that — it only fires on a total
# zero. Today every module happens to be named by an entry point too, so the walk
# finds the same set as before; that is a property of today's app.js, not a promise.
MODULE_SOURCES = ["/app.js", "/render.html"]

# The prefix a discovered reference must resolve under to be followed. This is a
# deliberate limit of the walk to ONE directory, not a network guard: the browser-global
# libraries (Konva, QRious and jsPDF from /vendor/, bootstrap from a CDN) are plain
# <script> tags rather than ES imports, and are already excluded by the regex below,
# which only matches specifiers starting with `./` or `../`. What this
# constant actually drops is a relative import resolving OUTSIDE /modules/ — say a
# module moved to static/lib/ and imported as `../lib/shared.js`. Such a file would
# then go unchecked, and the loud "nothing found" guard would not notice, because it
# only fires on a total zero. Widen this if the layout ever grows a second directory.
MODULE_DIR = "/modules/"

# Anchored to the IMPORT SYNTAX — a real `from '<relative path>.js'` clause — rather
# than matching a bare `./modules/foo.js` substring wherever it appears. Unanchored,
# the pattern also matches a module named in a prose comment or in a string literal,
# so a stray mention of a since-deleted module would redden the gate on a perfectly
# healthy image. There is no such occurrence in this codebase today — every `.js`
# specifier under static/ is a real `from '...'` clause — so this is prevention, not
# a fix for a live bug.
#
# Both quote styles are accepted, and both the `./x.js` and `../x.js` forms.
#
# Anchoring does NOT exclude a COMMENTED-OUT import: `// import x from './a.js';`
# still carries a real `from` clause and is still matched. Deleting a module and
# commenting out its import instead of removing the line therefore turns this gate
# red. That is the safe direction — a false red delays a publication, it never ships
# a broken image — but the fix is to delete the line, not to teach this regex to
# parse JS comments.
#
# NOT matched, deliberately and after checking: side-effect imports written as
# `import './x.js';` with no `from`, and dynamic `import('./x.js')`. Both are valid JS
# forms, but this codebase uses neither anywhere in static/. If one ever appears, add
# the alternative here — the loud "nothing found" guard below will not notice a
# reference style that simply stopped being matched past the first level.
MODULE_REF_RE = re.compile(r"""from\s+['"](\.{1,2}/[A-Za-z0-9_./-]+\.js)['"]""")

# Present only when ENABLE_PDF_API is set, which Dockerfile.backend does and
# Dockerfile does not.
PDF_API_ROUTE = "/api/generate-pdf"

# The smallest label that still exercises the whole pipeline: src/api.py drives headless
# chromium to /render.html, waits for networkidle, and calls window.renderPdf(); the page
# needs Konva to build the stage and jsPDF to emit the document, so a single missing
# /vendor/ file fails this and nothing else. The `%E1%` placeholder is substituted from
# the row's entities, which also proves the module graph really executed rather than the
# libraries merely being present. Validated against the live production renderer: 200,
# application/pdf, 5163733 bytes in 1.18 s.
PDF_RENDER_PAYLOAD = {
    "template": {"version": 1, "widthMm": 58, "heightMm": 40, "nodes": [
        {"type": "text", "text": "SMOKE %E1%", "x": 10, "y": 10, "rotation": 0,
         "scaleX": 1, "scaleY": 1, "fontSize": 24, "fill": "#000000",
         "width": 180, "height": 60, "align": "center", "verticalAlign": "middle"}]},
    "rows": [{"entities": ["OK"]}],
    "rotate": False,
}

# Its own budget, far above the file's 5 s TIMEOUT. A warm render answers in about 1.5 s,
# but this is the FIRST page chromium opens in a freshly started container — the browser
# still has to spin up a renderer process — and a CI runner is slower than the production
# host. Five seconds would produce a flaky red that says "the render is broken" when the
# render was merely starting up; sixty is generous enough that a timeout here means the
# thing genuinely hung, which is exactly the failure mode this check is here to catch.
PDF_RENDER_TIMEOUT = 60

# A one-label PDF from this payload runs to megabytes (the renderer rasterises the label
# at 600 DPI), so this floor is nowhere near it — it only has to be above what a stub, an
# error page or a truncated response could be. A valid but EMPTY jsPDF document is a few
# hundred bytes, and that is the real thing being excluded: a renderer that produced a
# structurally fine PDF containing nothing at all.
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
    # Status alone would not catch it: a style.css or an app.js truncated to zero
    # bytes (a botched build step, a half-written file) answers a perfectly good 200
    # and the app ships unstyled or without a single line of JavaScript. Emptiness is
    # the honest check — what the CSS or the JS should *contain* is not this gate's
    # business.
    if not body:
        return "200 but the body is empty (0 bytes)"
    return None


def check_vendor_asset(body, reason, minimum):
    """Return None when the vendored library answered 200 with a plausible size."""
    problem = check_asset(body, reason)
    if problem is not None:
        return problem
    if len(body) < minimum:
        return ("200 but only {} bytes, below the {} byte floor — that is not the "
                "library: a truncated copy, a placeholder, or an error page saved "
                "under a .js name".format(len(body), minimum))
    return None


def html_text(body):
    """Decode a fetched page for scanning; None when there is nothing to scan."""
    # A None body means the route's own fetch already failed and is already reported as
    # a broken target — the guards below turn that into an explicit "not checked" rather
    # than printing a green ok for a check that never looked at anything.
    if body is None:
        return None
    return body.decode("utf-8", "replace")


def check_no_external_scripts(body):
    """Return None when the page loads no <script> from any external host."""
    text = html_text(body)
    if text is None:
        return "not checked: the page did not load (its own failure is reported above)"
    external = EXTERNAL_SCRIPT_RE.findall(text)
    if external:
        # Every offending URL is listed, not just the first: a change that re-adds one
        # library usually re-adds all three, and seeing them together is the diagnosis.
        return ("{} external <script src> back in the page — the renderer must load "
                "nothing from a third-party host (vendor it into static/vendor/ "
                "instead): {}".format(len(external),
                                      ", ".join(repr(url) for url in external)))
    return None


def check_no_cdn_libs(body):
    """Return None when none of the three vendored libraries is loaded from a CDN."""
    text = html_text(body)
    if text is None:
        return "not checked: the page did not load (its own failure is reported above)"
    cdn_libs = CDN_LIB_RE.findall(text)
    if cdn_libs:
        return ("{} of the vendored libraries loaded from a CDN again — they must come "
                "from /vendor/: {}".format(len(cdn_libs),
                                           ", ".join(repr(url) for url in cdn_libs)))
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
        # The error body is read and truncated hard: src/api.py lets the playwright
        # exception reach FastAPI, so the first few hundred characters name the actual
        # cause (a goto timeout, a pageerror) instead of leaving a bare "HTTP 500".
        detail = error.read()[:500].decode("utf-8", "replace")
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
    # Only the magic number is ever looked at, and only its first bytes are ever printed:
    # the body is several megabytes and must not end up in a log or in a variable that
    # gets formatted into one.
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
    # Resolution is RELATIVE TO THE IMPORTING FILE, and that single detail is what
    # makes the transitive walk work at all: /app.js writes `./modules/state.js`,
    # while /modules/pdf.js writes `./state.js` for that very same file. Treating the
    # second form as a path from the document root would look for /state.js, resolve
    # nothing under /modules/, and silently collapse the whole walk back to its first
    # level — a no-op wearing the costume of a graph traversal.
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
        # Fail loudly rather than silently checking nothing. An empty result means
        # either the entry points could not be read or the regex stopped matching
        # (someone switched to bare specifiers, an import map or a bundler), and a
        # check that quietly degrades to zero targets is the worst possible outcome:
        # it stays green forever while covering nothing.
        return [("module discovery", "no relative `from './...js'` module imports "
                 "found in {} (readable sources: {}) — the import style changed, or "
                 "the entry points did not load".format(
                     ", ".join(MODULE_SOURCES),
                     ", ".join(readable) if readable else "none"))]

    # Breadth-first over the graph. `visited` is both the dedupe and the CYCLE GUARD:
    # ES modules are allowed to import each other in a loop (a -> b -> a runs fine in
    # a browser), so a walk without it would queue the same pair forever. Every route
    # is fetched at most once and only unvisited routes are ever queued, so the walk
    # is bounded by the number of distinct modules the server hands out.
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
        walked.append((route, problem))
        if problem is not None:
            # A module that failed to load is reported exactly like any other broken
            # target, and the walk simply carries on with the rest of the queue: one
            # missing file must not abort the traversal and hide the state of every
            # other module still waiting in it. Its own imports are unknowable — there
            # is no body to scan — so this branch only skips descending into it.
            continue
        for target in module_refs(route, body):
            if target not in visited:
                queue.append(target)

    # The count is printed on purpose: a human reading a GREEN log has to be able to
    # see that the check did not quietly degrade. A drop from ten modules to two — a
    # changed import style, a bundler, a regex that stopped matching past the first
    # level — otherwise looks exactly like a pass.
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

    # Assert on whether the ROUTE EXISTS, never on an exact status code. When the
    # route is registered, an empty JSON body makes FastAPI answer 422 (validation),
    # and a backend whose browser died would answer 503 — both prove the route is
    # there, and pinning the check to one of them would turn a healthy image red.
    # 404/405 is the "no such route" signal: static/ is mounted at "/", and
    # Starlette's StaticFiles rejects a POST with 405 before it ever looks at the
    # path, so that is exactly what the PDF-less image returns here.
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
    # No default on purpose. Defaulting either way would make the two matrix legs
    # indistinguishable the moment the workflow forgets to pass the variable: the
    # differentiator between the two images would silently stop being checked while
    # the gate stayed green.
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

    for route, minimum in VENDOR_ASSETS:
        body, reason = fetch(route)
        results.append((route, check_vendor_asset(body, reason, minimum)))

    # Reuses the bodies already fetched above — the entry points are both in
    # STATIC_ASSETS, so there is no point in asking for them twice.
    results.extend(check_modules(bodies))

    # Both guards read a body already fetched: "/" IS index.html (StaticFiles is mounted
    # with html=True) and /render.html is in STATIC_ASSETS, so neither page is requested
    # a second time.
    results.append(("/render.html (no external <script src>)",
                    check_no_external_scripts(bodies.get("/render.html"))))
    results.append(("/ index.html (konva/qrious/jspdf not from a CDN)",
                    check_no_cdn_libs(bodies.get("/"))))

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
