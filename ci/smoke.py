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
* It never renders a real PDF. static/render.html pulls Konva, QRious and jsPDF from
  cdn.jsdelivr.net and cdnjs.cloudflare.com, so an end-to-end render would depend on
  two third-party CDNs being reachable from the runner: the gate would go red on
  someone else's outage and block a perfectly good deploy. Do NOT "improve" this into
  a real render — the hermetic check below is deliberate.

For the backend image there is also no separate "did chromium start" probe, and none
is needed: src/api.py starts playwright and launches chromium inside the FastAPI
`lifespan` startup hook, so a browser that cannot start raises during startup and
uvicorn exits. The container dies instead of serving, the readiness loop in the
workflow sees an exited container and prints its logs. In other words, the fact that
the backend image answers HTTP at all already proves chromium launched.

Every target is checked before reporting, so one run shows the full extent of the
breakage rather than only the first broken thing.
"""

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
# deliberate limit of the walk to ONE directory, not a network guard: the CDN
# dependencies (Konva, QRious, jsPDF, bootstrap) are already excluded by the regex
# below, which only matches specifiers starting with `./` or `../`. What this
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

    # Reuses the bodies already fetched above — the entry points are both in
    # STATIC_ASSETS, so there is no point in asking for them twice.
    results.extend(check_modules(bodies))

    results.append(("POST " + PDF_API_ROUTE + " (EXPECT_PDF_API={})".format(
        "1" if expect_pdf_api else "0"), check_pdf_api(expect_pdf_api)))

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
