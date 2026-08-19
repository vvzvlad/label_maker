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
* The LIBRARIES are hermetic, and that is precisely why the render is now checked end
  to end. Konva, QRious and jsPDF live in static/vendor/ and are loaded from /vendor/
  (see docs/vendored-libs.md), so static/render.html and its whole module graph pull
  no third-party CODE at all, and the backend leg below renders a real PDF and
  inspects the bytes.
  What must never come back is an external `<script src="https://…">` — or an
  external `<link href>`, or an `import … from 'https://…'` inside a module — in
  render.html or under /modules/. That is what these guards exist to prevent: the
  libraries used to come from cdn.jsdelivr.net and cdnjs.cloudflare.com, the
  Cloudflare addresses were blackholed from the production host, chromium hung forever
  on the jsPDF script, `networkidle` never fired and every print came back HTTP 500.
  Re-adding an external reference would both re-break production behind a blocked CDN
  and put this gate at the mercy of someone else's uptime — red on their outage,
  blocking a perfectly good deploy. The guards below reject all three forms, and a
  positive check asserts the three /vendor/ files are actually referenced, since a
  purely negative guard stays green on a page that references nothing at all.

  THE GUARDS MATCH BROADLY, DELIBERATELY. A quoted URL (backticks included) counts
  wherever it appears in the body: inside a `//` or `/* */` comment, inside an
  `<a href>` that only MENTIONS a library, inside a string nothing ever passes to the
  DOM. They make no attempt to work out whether the surrounding text is code, prose or
  hypertext. Position-aware exemptions for the first two of those three shapes existed
  here and were removed, because each of them could lose synchronisation — one `<a` with
  no `>` after it, one unterminated `/*` — and exempt an arbitrary span of the file, or
  the whole rest of it, taking a real CDN reference inside that span with it. For this
  gate the trade runs one way only: a false red is a loud one-line fix by whoever wrote
  the line, a false green ships an image that hangs in production and takes printing
  down.
  So when the gate reds on a line that fetches nothing — move the URL out of the file,
  or reword the comment so it does not spell a URL out. Both are cheaper than a scanner
  that can silently turn the whole check green.
  There is a third answer, but it fits ONE of the three guards: adding a whole URL to
  NEVER_FETCHED_URL_NAMES below only ever helps the broad URL scan
  (check_no_external_urls, i.e. /render.html and the bodies under /modules/), which is
  the only guard that reads that set. The entry must be the ENTIRE identifier, since the
  test is equality — a prefix of one exempts nothing now. A red from the library-keyed
  guard — check_no_cdn_libs, on "/", /app.js and /render.html — is NOT fixable that way:
  it never consults the allowlist, so an entry added for it changes nothing and the red
  stays. There the fix is to move the URL out of the file, exactly as the CDN_LIB_RE
  comment says.

  The known limits, so a green run is not read as more than it is: the library-keyed
  guard fires on a library name appearing after `//` inside ONE string literal, or in an
  unquoted `src=`/`href=` value, so a URL split across a concatenation
  (`BASE + "konva@9/+esm"`), a JSON-escaped one (the same URL with every slash
  backslash-escaped — a form SOME encoders produce, not the norm: neither
  `JSON.stringify` nor `json.dumps` escapes a forward slash by default) and a CDN URL
  that never names the library at all are all invisible to it.
  An UNQUOTED URL in a comment is only PARTLY invisible, and the text here used to
  overstate that. A prose citation — `// see https://cdn.jsdelivr.net/npm/konva@9/…` —
  really does match nothing, since outside an attribute value both guards want a quote
  on each side of the URL (that is what keeps a citation from reddening the gate; see
  EXTERNAL_URL_RE). But the library-keyed guard's unquoted arm lost its lookbehind and
  has no idea where it is looking, so a comment that spells an ATTRIBUTE out —
  `// like <script src=//cdn.jsdelivr.net/npm/konva@9/konva.min.js>` — DOES fire. That
  is a false red, the safe direction, and the fix is the usual one: reword the comment.
  In that case expect the reported URL to be a little off, too — an unquoted match runs
  to whitespace, so a `)`, `]` or comma ending the sentence lands inside the URL the
  failure prints. A `>` does not — the character class excludes it, which is why the
  markup example above reports a clean URL.
  It is a regression guard against the shape that broke production, not an exhaustive
  proof of hermeticity.

  This does NOT mean the application never touches the network, and the docstring used
  to overclaim exactly that. It is true of the smoke PAYLOAD below, which is text
  only. It is not true in general: a template node of `type: "image"` with
  `isUrl: true` makes static/render.html load an arbitrary external URL (hence the
  `_proxy_images` route handler in src/api.py), and `loadImageFromUrl` in
  static/modules/utils.js sets no timeout — so a blackholed image host reproduces the
  very same "render hangs, `networkidle` never fires, HTTP 500" failure this commit
  fixed for the libraries. That failure class is still open and out of scope here; it
  is named so nobody mistakes a green run for proof that it cannot happen.

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
#
# The three vendor script tags below are appended to that list as the POSITIVE half of
# the vendoring guard. check_no_cdn_libs only rejects a bad reference, so deleting the
# three <script src="/vendor/…"> tags outright passed every check while the public UI
# shipped dead: no Konva, no QRious, no jsPDF, a blank editor. The backend leg is
# covered by the real render further down — it cannot produce a PDF without the
# libraries — but the plain image has no equivalent, and "/" is the only place its
# breakage would ever have shown.
VENDOR_SCRIPT_MARKERS = [
    'src="/vendor/jspdf.umd.min.js"',
    'src="/vendor/konva.min.js"',
    'src="/vendor/qrious.min.js"',
]

HTML_ROUTES = [
    ("/", ['id="entities-tbody"', 'id="btn-generate"', 'id="konva-container"']
          + VENDOR_SCRIPT_MARKERS),
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
# turn it red. Each floor sits a little over a quarter of the real size. The exact byte
# counts and SHA-256 sums live in docs/vendored-libs.md and only there, so a version bump
# is one edit rather than four.
#
# A floor alone does not IDENTIFY a file, though: swap konva.min.js for a copy of
# jspdf.umd.min.js, or copy the wrong file during a refresh, and every size check still
# passes while the page is broken. Hence a content marker per library. All three markers
# below were grepped out of the vendored bytes in this tree before being relied on here.
#
# The konva and qrious markers come from the library's own preamble banner. Be precise
# about what that proves and what it does not: it proves the body is THAT library rather
# than one of the other two, and that it is a library at all rather than an error page
# saved under a .js name. It does NOT prove the BUILD — the same banner sits at the top of
# konva.esm.js and of the ESM qrious bundle, which a classic <script src> cannot execute.
# No cheap build pin exists for those two: their UMD wrappers end in `.Konva=e()` /
# `.QRious=e()`, where `e` is a minifier-generated name that a version bump can rename, so
# a marker built on it would eventually go red on a perfectly good refresh.
#
# jsPDF gets a marker that pins the build as well, because there one exists for free.
# `jspdf={}` is the UMD wrapper's global assignment — `(t=t||self).jspdf={}` — i.e. the
# very line that creates `window.jspdf`, which is what render.html calls
# (`new window.jspdf.jsPDF(...)`). It carries no minifier-generated identifier, so it
# survives a version bump. The obvious marker, the bare string "jsPDF", was considered and
# rejected for exactly that reason: `jspdf.es.min.js` — the ESM bundle, the neighbouring
# file on the same CDN path and the easy one to grab during a refresh — contains "jsPDF"
# hundreds of times and is far over the floor, so it would satisfy such a marker while
# `window.jspdf` never appears and every render dies. `jspdf={}` is the one string that
# tells the two builds apart.
#
# Their absence is invisible everywhere else: "/" and /render.html both answer a flawless
# 200 with a missing /vendor/ directory, and the app is dead the moment a browser — or
# headless chromium in the backend image — actually loads the page.
VENDOR_ASSETS = [
    ("/vendor/konva.min.js", 50000, "Konva JavaScript Framework"),
    ("/vendor/qrious.min.js", 5000, "QRious"),
    ("/vendor/jspdf.umd.min.js", 100000, "jspdf={}"),
]

# Matches a <script src> or a <link href> pointing at another host: an absolute http(s)://
# URL or the protocol-relative //host/… form. Everything render.html should load is
# same-origin and root-relative (`/vendor/konva.min.js`, `./modules/utils.js`), so this
# pattern has no legitimate match there at all.
#
# <link> is matched as well as <script> because an external stylesheet is a
# render-blocking subresource: `<link rel="stylesheet" href="https://…">` stalls
# `networkidle` behind a blackholed host exactly as a script tag does. What that
# extension does NOT do is close a hole — this comment used to claim it did, and the
# claim was wrong. This pattern is pointed at exactly one body, /render.html, and that
# same body is also scanned by EXTERNAL_URL_RE (check_no_external_urls), which matches
# any quoted external URL and therefore already sees every such <link>. At the current
# call site the two checks overlap and this is simply the more specific of them: it names
# the failure ("an external <script src>/<link href> is back in the page") instead of
# reporting a URL somewhere in the body, and it reads unquoted attributes, which the
# quoted-string-only URL scan cannot. The <link> arm would start carrying its own weight
# the moment this guard is pointed at a page where the broad scan cannot be used at all —
# any page that legitimately names external hosts, i.e. index.html.
#
# BOTH attribute syntaxes are matched. An unquoted `src=//host/x.js` is legal HTML that
# browsers honour, and the old quote-anchored pattern could not see it: the guard was one
# missing pair of quotes away from being decorative.
#
# The attribute name is guarded by `(?<![\w-])` rather than by `\b`, because a hyphen is a
# word boundary: `\bsrc\s*=` happily matched `data-src=`, an attribute that loads nothing at
# all, and would have reported it as an external <script src>. index.html already carries a
# `data-site-id` attribute, so data-attributes are live style on these pages rather than a
# hypothetical.
EXTERNAL_REF_RE = re.compile(
    r"""<(?:script|link)\b[^>]*?(?<![\w-])(?:src|href)\s*=\s*"""
    r"""(?:["']((?:https?:)?//[^"']*)["']|((?:https?:)?//[^\s"'>]+))""", re.I)

# Matches an external URL naming one of the three VENDORED libraries — the exact regression
# static/vendor/ exists to prevent. Narrower than EXTERNAL_REF_RE in WHICH URLs it objects
# to, and wider in where it looks for them. Narrower because index.html legitimately keeps
# loading Bootstrap, the Bootstrap Icons font CSS and the rybbit analytics script from
# external hosts: only the three libraries were vendored, and a guard that failed on any
# external URL there would be a guard nobody could keep green.
#
# The key is the LIBRARY NAME in an external URL, not a host allow-list. The previous
# version matched only cdn.jsdelivr.net and cdnjs.cloudflare.com, which made it a list of
# the two hosts that happened to be in use before the fix — unpkg.com,
# fastly.jsdelivr.net, esm.sh or a company mirror serving konva/qrious/jspdf all sailed
# through, and each of them re-creates the identical failure. The host is incidental; what
# must never happen is one of THESE THREE libraries arriving over the network, from
# anywhere. Keying on the name also means no maintenance when a new CDN appears.
#
# The name is matched in ANY string literal — single-quoted, double-quoted or backtick —
# and in an unquoted HTML attribute value. It is deliberately NOT restricted to a position
# that "loads a subresource". A previous version was: it accepted only `<script src>`,
# `<link href>` and a short list of JavaScript loading forms (`from '…'`, `import('…')`,
# `fetch('…')`, `el.src = '…'`), and that list turned out to be a sieve on "/" and /app.js,
# the two bodies where this guard is the ONLY one. All of these fetch one of the three from
# a CDN and all of them passed it:
#   * an import map — `<script type="importmap">{"imports":
#     {"konva":"https://cdn.jsdelivr.net/npm/konva@9/+esm"}}</script>` — the canonical
#     modern way to keep a bare `import Konva from 'konva'` in app.js while sourcing it
#     from a CDN, i.e. precisely the regression /app.js was brought under guard for;
#   * an indirect load: `const U = "https://cdn.jsdelivr.net/npm/konva@9/konva.min.js";
#     await import(U)` — the URL and the `import` are not even on the same line;
#   * `s.setAttribute('src', 'https://cdnjs.cloudflare.com/…/jspdf.umd.min.js')` and
#     `Object.assign(document.createElement('script'), {src:'https://unpkg.com/qrious'})`,
#     neither of which is written as an assignment to `.src`;
#   * a template literal: `import(`https://esm.sh/konva@9`)`, since that list of forms
#     never treated a backtick as a string delimiter although EXTERNAL_URL_RE below does.
# The first two were caught by the host-keyed version that came before it, so the narrowing
# lost real coverage. An external URL naming konva, qrious or jspdf has no innocent reason
# to appear in these files at all; by which syntax it eventually reaches the browser is not
# something a regex should have to enumerate ahead of the person adding it.
#
# NOTHING is exempted by position. A credits link — `<a href="https://github.com/parallax/
# jsPDF">Powered by jsPDF</a>` — fetches nothing and still fires, and that is the accepted
# cost. An anchor exemption lived here and was deleted: it was expressed as "inside an
# `<a …>` opening tag", `<a` with no `>` after it is ordinary JavaScript (`i<a.length`), and
# any later `>` — an arrow function, a comparison — closed the imagined tag, so an arbitrary
# span of the file stopped being checked and a real `s.src = "https://cdn…/konva.min.js"`
# inside that span passed. The exemption also covered the whole opening tag, so
# `<a href="#" onclick="loadLib('https://cdn…/jspdf.umd.min.js')">` — a perfectly realistic
# way for jsPDF to come back — passed too. It was defending against a false red nobody has
# ever seen (index.html's footer credits Asakusa Lab; `https://asakusa-lab.cc/` carries no
# library name) at the price of a demonstrable false green in the one check whose entire job
# is to stop a CDN reference from reaching production. If a credits link to one of the three
# projects is ever wanted, the fix is to put the URL somewhere this guard does not read —
# not to teach the guard to guess at HTML structure.
#
# Two alternatives, then:
#   1. the URL inside a string literal, `"…"` / `'…'` / `` `…` ``. Every quoted HTML
#      attribute is also a string literal, so `<script src="https://…/konva.js">` is
#      covered by this arm too — the tag does not need its own.
#   2. an unquoted attribute value (`src=//host/konva.js`): legal HTML that browsers
#      honour, for the same reason as in EXTERNAL_REF_RE above — but WITHOUT that
#      guard's `(?<![\w-])` lookbehind on the attribute name, so `data-src=` and any
#      other `…-src=` / `…-href=` spelling trips this one. The lookbehind is right in
#      EXTERNAL_REF_RE, whose claim is that a <script src>/<link href> loads from
#      another host: `data-src=` loads nothing, so reporting it there is a plain false
#      red. Here the claim is different — no external URL naming one of the three
#      libraries, in any syntax — and the lookbehind was a position-based exemption
#      under a comment declaring there are none: it let
#      `<script data-src=//cdn.jsdelivr.net/npm/konva@9/konva.min.js>` through, one
#      `document.querySelector('[data-src]')` away from loading konva off a CDN. The
#      hole was narrow (the quoted spelling was still caught by arm 1) and it is now
#      closed. Checked before dropping it: today's index.html carries `data-bs-theme`,
#      `data-site-id` and `data-stroke-row`, none of them an unquoted URL naming a
#      library, so this widening adds no red to any body the gate scans.
#
# The URL must be external — both alternatives start at `//` or `https?://`, so the
# legitimate same-origin `"/vendor/jspdf.umd.min.js"` and a relative `'./modules/pdf.js'`
# cannot match. Verified against today's index.html: the bootstrap@5.3.3 stylesheet, the
# bootstrap-icons@1.11.3 font CSS, the bootstrap.bundle.min.js script, the rybbit analytics
# script and the Asakusa Lab credits link all stay clean — none of them names one of the
# three libraries. That is the property the old narrow regex existed to protect, and it is
# preserved.
#
# What it cannot see, and no amount of pattern work would fix: the library name has to
# appear after the `//` INSIDE ONE string literal. A URL assembled from pieces
# (`BASE + "konva@9/+esm"`), a JSON-escaped one (`"https:\/\/esm.sh\/konva"`) and a CDN URL
# that never spells the library out (`"https://cdn.example/lib/k.min.js"`) all pass. This is
# a guard against the shape that actually broke production, not a proof of hermeticity.
CDN_LIB_RE = re.compile(
    r"""["'`]((?:https?:)?//[^"'`]*(?:konva|qrious|jspdf)[^"'`]*)["'`]"""
    r"""|(?:src|href)\s*=\s*"""
    r"""((?:https?:)?//[^\s"'`>]*(?:konva|qrious|jspdf)[^\s"'`>]*)""",
    re.I)

# Matches an external URL ANYWHERE in a body, tag or no tag. EXTERNAL_REF_RE only sees
# markup, so `import { x } from 'https://esm.sh/konva'` inside a module — or inside
# render.html's own inline `<script type="module">` — went completely unchecked while the
# docstring claimed the whole module graph reached no third-party host. A dynamic
# `import('https://…')`, a `fetch('https://…')` and a `new Image().src = 'https://…'` are
# all caught by the same pattern, which is the point: at this level the syntax does not
# matter, the URL does.
#
# Applied ONLY to the /modules/… bodies and to /render.html — never to "/" or /app.js. The
# public UI legitimately talks to external hosts (Bootstrap, the icon font, rybbit
# analytics), so pointing this at index.html would produce a permanent red nobody could
# fix, and app.js is that page's entry point. Neither of those two is left UNCHECKED,
# though — both get the narrow library-keyed CDN_LIB_RE guard (check_no_cdn_libs), which
# stays quiet about Bootstrap while still catching an import of konva/qrious/jspdf from
# anywhere. This exclusion is about which guard fits, not about skipping a file.
#
# The URL must sit INSIDE A STRING LITERAL: a quote — ", ' or a template-literal
# backtick — is required on both sides of it, for the absolute `https?://…` form as well
# as for the protocol-relative `//host/…` one, and the protocol-relative arm additionally
# requires a dotted host. Everything that FETCHES a URL has to quote it, so
# `import … from 'https://…'`, `import('https://…')`, `fetch("https://…")`,
# `el.src = 'https://…'` and every quoted HTML attribute all still fire. What stops
# matching is url-looking PROSE: an UNQUOTED address in a comment or a license header, which
# matters because this repo is written in a deliberately comment-heavy style — the version
# before that one matched ANY `https?://…` text anywhere in a body, so the first module
# comment citing a spec URL would have turned the gate red on a perfectly healthy image.
#
# A QUOTED URL in a comment does fire, including a backtick-quoted one — and since this
# codebase quotes links in backticks inside comments, a module comment reading
# ``// see `https://developer.mozilla.org/…` `` is a red.
# That is deliberate. A comment-skipping scanner lived here (`comment_spans`) and
# was deleted: an unterminated `/*` made it treat everything to end of file as a comment, and
# a `//` outside a string — `url(//img.example.com/a.png)` in an inline `<style>` — opened a
# phantom comment that swallowed the rest of its line, so a real
# `import("https://esm.sh/konva@9")` after either one went unchecked. A URL contains `//`
# itself, so any such scanner is one mis-parse away from exempting the very import this guard
# exists to catch. The fix for a red comment is to reword it — drop the URL, or name the
# document instead of its address — which costs one line and cannot go wrong quietly.
#
# ONE exemption remains and it is an explicit allowlist rather than a position guess:
# NEVER_FETCHED_URL_NAMES below, filtered in check_no_external_urls after the regex has run
# by exact match. It carries the XML namespace identifiers, which are quoted (so the rule
# above does not save them) and are names rather than addresses — nothing ever fetches them.
#
# re.I because URL schemes are case-insensitive per RFC 3986: the browser executes
# `import K from 'HTTPS://esm.sh/konva'` exactly like the lowercase form. Without the flag
# that import matched nothing anywhere — this is the only external-URL check pointed at
# module bodies, and EXTERNAL_REF_RE/CDN_LIB_RE were already case-insensitive.
#
# What it still cannot see, honestly stated: a URL COMPUTED from fragments
# (`fetch('https:' + '//esm.sh/' + name)`, a base64-decoded string) or escaped inside its own
# literal (`"https:\/\/esm.sh\/konva"`) — no regex catches those. And, by construction, an
# unquoted URL in an HTML attribute (`href=https://cdn…`): for /render.html that form is
# covered by EXTERNAL_REF_RE's unquoted arm, and inside a JS module it is not a syntax that
# exists at all.
EXTERNAL_URL_RE = re.compile(
    r"""["'`](https?://[^\s"'`>]+)["'`]"""
    r"""|["'`](//[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+[^\s"'`>]*)["'`]""", re.I)

# URL NAMES that never denote something a browser fetches, dropped from the
# check_no_external_urls result after the match. Today that is exactly the five W3C XML
# namespace names listed below: per the Namespaces in XML standard a namespace name is an
# IDENTIFIER that happens to be spelled as a URI, and no conforming processor ever
# dereferences it — so
# `createElementNS('http://www.w3.org/2000/svg', 'svg')` and an `xmlns` attribute inside an
# SVG data-URI are ordinary SVG code, not a third-party load. static/index.html already
# carries one in its favicon, so the first SVG helper copied into static/modules/ would
# otherwise redden this gate for nothing. `http://www.w3.org/2000/xmlns/` is in the set for
# that same helper: it is the namespace `setAttributeNS` needs to put `xmlns` / `xmlns:xlink`
# on a standalone serialised SVG, and it is exactly as unfetchable as the other four.
#
# The comparison is EQUALITY, not a prefix test, and the entries are the FULL IDENTIFIERS.
# A prefix test exempts a whole SUBTREE rather than a name, and the subtrees under these
# five identifiers are real, dereferenceable W3C content:
# `http://www.w3.org/1999/xhtml/vocab` (the RDFa vocabulary document) and a fabricated
# `http://www.w3.org/2000/svg/x.js` both start with an entry and would have been waved
# through. `http://www.w3.org/1999/xhtml.js` was exempt too — a prefix does not even stop at
# a path separator. For a module body this scan is the ONLY guard there is, so an exemption
# that leaks past the name itself is the last remaining way a fetch of a blackholed host
# passes silently. A namespace name is a fixed string; comparing it as one costs nothing and
# bounds the exemption to the thing that really is a name.
#
# Two spellings are deliberately absent. The protocol-relative `//www.w3.org/…` form is not
# a namespace name at all: per Namespaces in XML a namespace name is an ABSOLUTE URI, i.e.
# one with a scheme, so `xmlns="//www.w3.org/2000/svg"` names a different (and wrong)
# namespace — there is no legitimate spelling to exempt. The `https://` form is likewise not
# the same namespace as the `http://` one: the SVG/xlink/xhtml namespaces are defined with
# `http://`, so an `https://` xmlns is a common hand-written typo that produces a document
# nothing renders. It is left out so the gate reds on it. If an https entry is ever genuinely
# needed, add it as the same full identifier path with a note saying why — never as the host
# root, which is the hole this set was narrowed to close.
#
# Which typos this exemption forgives, plainly, because the two rules above and the
# case-folding below do NOT say the same thing. The URL is lowercased before the test, so
# the comparison is case-insensitive over the WHOLE URL, path included — not just the scheme
# and host that RFC 3986 makes case-insensitive. So `http://www.w3.org/2000/SVG` and
# `HTTP://WWW.W3.ORG/2000/svg` are both silently exempt, although a namespace name is
# case-SENSITIVE and the first of those names a different (nonexistent) namespace: a
# wrong-case typo is forgiven, and the gate will not tell you about it. What is NOT forgiven
# is anything that changes the characters themselves: a wrong scheme (`https://`), a missing
# or extra path segment, a trailing slash where the identifier has none. Those red, which is
# the intended direction — the exemption is meant to be narrow, and case is the one axis
# where it is wider than the standard it models.
#
# The entries themselves must be written in LOWERCASE, or they match nothing at all: the XML
# namespace identifier is spelled `http://www.w3.org/XML/1998/namespace` in the standard, and
# an entry carrying that uppercase `XML` would never equal the lowercased URL it is compared
# against. It fails safe (a red, not a green), but it fails silently in the sense that the
# entry simply does no work, so keep new entries lowercase.
#
# Add to this set when — and only when — a URL genuinely cannot be fetched by anything, and
# add the WHOLE identifier: with an equality test a partial entry no longer exempts anything
# at all, so there is no half-measure to get wrong. A one-line addition here is the intended
# answer to a false red from check_no_external_urls; it is bounded and visible, unlike a
# scanner that decides which REGIONS of a file to stop checking.
NEVER_FETCHED_URL_NAMES = frozenset((
    "http://www.w3.org/2000/svg",
    "http://www.w3.org/1999/xlink",
    "http://www.w3.org/1999/xhtml",
    "http://www.w3.org/xml/1998/namespace",
    "http://www.w3.org/2000/xmlns/",
))

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
# libraries merely being present.
#
# This check has been run end to end against a server built from THIS tree, with the
# vendored libraries, driving playwright's chromium. Both legs came back fully green:
# 26/26 targets with EXPECT_PDF_API=1 (the label_maker-backend leg, the one that includes
# this render) and 25/25 with EXPECT_PDF_API=0 (the plain label_maker leg, which has no
# route to render with). A real PDF came back, and /render.html fetched all 7 of its
# assets — the page itself, the three /vendor/ scripts and three modules — from
# localhost, with zero external requests of any kind. That last part is what makes it
# evidence for the vendoring rather than for the payload alone. The counts are written
# down because the whole point of this paragraph is to record a real run; keep them in
# step with the file, a stale number here is worse than no number at all. (They went up by
# one on each leg when check_no_cdn_libs was pointed at /render.html as well; the version
# before that said "25/25" and "24/24", and an older one still said "22/22", which by then
# matched no leg at all. An even earlier one
# cited a run against the live production renderer, which at the time still served the
# OLD image — CDN libraries plus a temporary `extra_hosts` pin — so it validated the
# payload SHAPE and nothing about the code path being gated here.)
#
# No byte count is recorded on purpose: the output size moves with the render DPI, the
# chromium version and the jsPDF encoder, so a figure here would rot into a lie without
# anything being wrong. PDF_MIN_BYTES below already carries the only part that means
# something — "not an empty document".
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


def check_vendor_asset(body, reason, minimum, marker):
    """Return None when the vendored library is both big enough AND the right library."""
    problem = check_asset(body, reason)
    if problem is not None:
        return problem
    # Size and identity are separate diagnoses and are reported separately: "too short"
    # means the download was truncated or replaced by an error page, while "right size,
    # wrong content" means a file swap or a wrong-file copy during a refresh. Both are
    # listed when both apply — a body can perfectly well be short AND not the library.
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
    # A None body means the route's own fetch already failed and is already reported as
    # a broken target — the guards below turn that into an explicit "not checked" rather
    # than printing a green ok for a check that never looked at anything.
    if body is None:
        return None
    return body.decode("utf-8", "replace")


def matched_urls(pattern, text):
    """Every non-empty capture group of `pattern` in `text`, in order, deduplicated.

    The patterns above are alternations — quoted attribute / unquoted attribute, absolute
    URL / protocol-relative URL — so exactly one group is filled per match and `findall`
    would hand back tuples full of empty strings. Deduplicated because the same URL
    repeated in a page is one problem, not several.

    WHERE in the text a match sits is deliberately not considered. A `skip_spans` argument
    used to let callers exempt ranges — the inside of an `<a …>` tag, the inside of a
    comment — and it was removed: computing those ranges means parsing HTML and JS with
    heuristics, and every way of getting that wrong exempts a region that holds a real CDN
    load. The exemptions that survive are by URL VALUE (NEVER_FETCHED_URL_NAMES, compared
    for equality), which cannot lose synchronisation with the text.
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
    # The one exemption, applied by VALUE and after the match: a URL that IS one of the
    # never-fetched names is a name, not a load. Exact membership, never a prefix test —
    # a prefix exempts everything under the identifier as well (`…/1999/xhtml/vocab`,
    # `…/2000/svg/x.js`), and for a module body this is the only guard there is.
    # Lowercased for the test because the entries are lowercase; see the note on the set
    # for exactly which typos that forgives.
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
    # The POSITIVE half of the vendoring guard. check_no_cdn_libs and
    # check_no_external_refs are both negative: they reject a bad reference and say
    # nothing about a MISSING one, so deleting the three <script src="/vendor/…"> tags
    # outright kept every check green while the page shipped without Konva, QRious or
    # jsPDF. Absence is a real and easy regression — a botched merge, an over-eager
    # "unused tag" cleanup — and on the plain image nothing else would catch it.
    missing = [marker for marker in VENDOR_SCRIPT_MARKERS if marker not in text]
    if missing:
        # The page is named by the result label this reason is printed against, so it is
        # not repeated here — that is why this function takes no `label` argument.
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
        # Counted in URLs, not in libraries: the list is deduplicated by URL, so two
        # different CDN spellings of konva are two entries here and one broken library.
        # The old wording said "N of the vendored libraries", which turned that into
        # "2 of the vendored libraries" and sent the reader looking for a second one.
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
        # The error body is read and truncated hard. Whether it says anything useful
        # depends entirely on the explicit `except Exception` handler in src/api.py's
        # generate_pdf, which logs the traceback and re-raises as an HTTPException whose
        # detail is "<ExceptionType>: <message>" — that is what names the real cause here
        # (a goto timeout, a pageerror). It is NOT something FastAPI does on its own: with
        # that handler removed the exception reaches Starlette, which answers a bare
        # `Internal Server Error` with debug off, this line prints exactly that, and the
        # cause survives only in the container logs. If you ever see the bare string here,
        # look at the handler before you look at the renderer.
        #
        # The cap sits well ABOVE the 500 characters src/api.py truncates its own detail to,
        # on purpose. The body is JSON — `{"detail":"…"}` — so a 500-BYTE slice of a
        # maximum-length detail loses the closing quote and brace and, worse, the trailing
        # `...` that api.py appends to mark its own cut, leaving a CI log that looks like a
        # complete message but is not. The slack also keeps the slice away from the end of
        # the text, where a byte cut through a multi-byte UTF-8 sequence would turn into
        # replacement characters — but only while the body is SHORTER than the cap, in
        # which case `[:2000]` takes all of it and cuts nothing. On a body that really is
        # longer, the cut happens at byte 2000 wherever that falls, possibly mid-character;
        # `errors="replace"` keeps that from raising, at the price of a replacement
        # character or two at the very end of the printed detail.
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
        if problem is not None:
            # A module that failed to load is reported exactly like any other broken
            # target, and the walk simply carries on with the rest of the queue: one
            # missing file must not abort the traversal and hide the state of every
            # other module still waiting in it. Its own imports are unknowable — there
            # is no body to scan — so this branch only skips descending into it.
            walked.append((route, problem))
            continue
        # Scanned HERE because the body is already in hand: fetching every module a second
        # time from a dedicated check would double the request count for no gain. A module
        # that reaches a third-party host — an `import` from esm.sh, a fetch of a font —
        # re-creates the exact hang this gate exists to prevent, and nothing else would
        # see it: EXTERNAL_REF_RE only reads markup and is only ever pointed at
        # render.html.
        walked.append((route, check_no_external_urls(body)))
        # Deliberately OUTSIDE that check: an external URL is a content problem, not a
        # transport one. The body loaded fine, so its imports are perfectly readable and
        # the walk must descend into them anyway — bailing out here would let one bad
        # module hide the entire subtree underneath it.
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
    # The same library-keyed guard is now aimed at THREE bodies, for two different reasons.
    # On "/" and /app.js it is the ONLY guard: the public UI legitimately loads Bootstrap,
    # the icon font and the analytics script from external hosts, so the broad URL scan
    # cannot be pointed there without a permanent red, and this one stays quiet about all of
    # them while still firing on konva/qrious/jspdf from anywhere.
    # On /render.html it is a THIRD NET under two stricter ones, and it earns its place by
    # catching the forms their own rules exclude. EXTERNAL_REF_RE deliberately ignores
    # `data-src=` (its `(?<![\w-])` lookbehind is correct there: a data-attribute loads
    # nothing as an HTML attribute), and EXTERNAL_URL_RE requires a quote on each side of
    # the URL. So `<script data-src=//cdn.jsdelivr.net/npm/konva@9/konva.min.js>` — one
    # `document.querySelector('[data-src]')` away from loading konva off a CDN — passed both
    # of them, and passed the gate entirely because this guard was not looking at the page
    # whose hung `networkidle` took printing down. The one false red it can add here is an
    # unquoted `data-` attribute that genuinely loads nothing — which is the very shape this
    # target exists to catch, so that red is the feature. Beyond it this guard asks nothing
    # the two above do not: render.html references no external host at all.
    results.append(("/render.html (konva/qrious/jspdf not from a CDN)",
                    check_no_cdn_libs(bodies.get("/render.html"))))
    results.append(("/ index.html (konva/qrious/jspdf not from a CDN)",
                    check_no_cdn_libs(bodies.get("/"))))
    # /app.js was this gate's one blind spot, and it is the public UI's entry point. It
    # is not covered by anything above: check_no_external_urls cannot be pointed at it
    # (its page legitimately loads Bootstrap and the analytics script), and the module
    # walk only follows the routes it DISCOVERS under /modules/ — it never scans the
    # entry-point bodies themselves. So an `import { jsPDF } from
    # "https://cdn.jsdelivr.net/npm/jspdf@2/+esm"` added to static/app.js used to pass
    # the whole gate green, which is exactly the regression this file exists to catch.
    # The narrow library-keyed guard is the right one here for the same reason it is the
    # right one for index.html: the public UI may legitimately reference external hosts,
    # so the broad URL scan would be a permanent red, while this one only ever fires on
    # konva/qrious/jspdf arriving over the network.
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
