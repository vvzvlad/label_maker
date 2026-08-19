# Vendored JavaScript libraries

The three libraries the label renderer needs are checked into the repository and shipped
inside the image instead of being pulled from a CDN at page load.

## Why

`Dockerfile.backend` builds `label_maker-backend`, which runs headless chromium and serves
`POST /api/generate-pdf`. That endpoint loads `/render.html` with
`wait_until="networkidle"` and then calls `window.renderPdf(...)` in the page.

While these libraries were loaded from `cdn.jsdelivr.net` and `cdnjs.cloudflare.com`,
the renderer depended on two third-party hosts being reachable from wherever the backend
container happened to run. On the production host that stopped being true: the IPv4
addresses of `cdnjs.cloudflare.com` were blackholed, the TLS handshake timed out, and the
container has no IPv6 — so chromium hung on the jsPDF `<script>`, `networkidle` never
fired, `Page.goto` died on its timeout and the API answered HTTP 500. Printing was down
until an `extra_hosts` pin to a working Cloudflare IPv4 was deployed as a stopgap.

Vendoring removes that dependency: the LIBRARIES no longer come from the network.
`/render.html` and its module graph reference no external host, so `Page.goto` can no
longer hang on a third-party script. `ci/smoke.py` enforces this — it serves the assets,
checks that both pages really do reference all three `/vendor/` files, guards against an
external `<script src>` or `<link href>` creeping back into `render.html` or an external
URL appearing in a module, and renders a real PDF end to end on the backend image.

This does NOT make every render hermetic, and the distinction matters. A template node of
`type: "image"` with `isUrl: true` still loads an arbitrary external URL at render time —
that is what `_proxy_images` in `src/api.py` exists to serve — and `loadImageFromUrl` in
`static/modules/utils.js` sets no timeout on the load. A template pointing at a blackholed
image host therefore reproduces exactly the failure this change fixed for the libraries:
the image never arrives, `networkidle` never fires, `Page.goto` dies on its timeout and
the API answers HTTP 500. That failure class is still open and is deliberately out of
scope here; it is written down so nobody reads "vendored" as "offline".

Both pages load the vendored files from `/vendor/`: `static/render.html` (the offline
renderer) and `static/index.html` (the public web UI).

This document lives in `docs/` rather than next to the files it describes: `static/` is
mounted at `/`, so anything under `static/vendor/` is served publicly (it would sit at
`https://labeler.asakusa-lab.cc/vendor/README.md`) and ships inside both images. Only the
three `.js` files belong there.

## Contents

| File | Library | Version | Bytes | SHA-256 |
| --- | --- | --- | --- | --- |
| `konva.min.js` | Konva | 9.3.22 | 175354 | `4655b6cd12d0d2ee5f6d461fa98c3611b1f9979b9106f18221bf0e6a90ab6745` |
| `qrious.min.js` | QRious | 4.0.2 | 17579 | `db99dcaf40a926181bce4522477c2efc5924f6c4b29111b6a97faea477c9528b` |
| `jspdf.umd.min.js` | jsPDF (UMD bundle) | 2.5.1 | 364463 | `98ccf17aa10c20bb1301762618fcc9b6ab3a4e7f26b6071d64d0b41154df3875` |

This table is the single place these numbers live: `ci/smoke.py` deliberately carries size
FLOORS and content markers rather than exact figures, so a version bump is one edit here
and not four scattered ones.

The files are byte-identical to upstream — no reformatting, no added header comments — so
the claim above is checkable rather than a promise. Verify the current tree with:

```sh
shasum -a 256 static/vendor/konva.min.js static/vendor/qrious.min.js static/vendor/jspdf.umd.min.js
```

## Missing source maps are expected

`jspdf.umd.min.js` and `qrious.min.js` both end with a `//# sourceMappingURL=….map` line,
and the `.map` files are deliberately NOT vendored: they are development artefacts worth
several times the library itself, and nothing in this application reads them.

The visible consequence is that browser devtools asking for `/vendor/jspdf.umd.min.js.map`
or `/vendor/qrious.min.js.map` get a same-origin 404 and show minified sources. This is
known and harmless — no external request is made, the app and the headless render are
completely unaffected, and it is not a symptom of a broken or truncated download. Do not
spend time investigating it. (`konva.min.js` carries no such line at all.)

## Sources and how to refresh

Every URL is pinned to an exact version. `konva@9` used to be an unpinned major range that
now resolves to 9.3.22; keep the exact version in the URL so the vendored bytes stay
reproducible.

Konva 9.3.22 — <https://cdn.jsdelivr.net/npm/konva@9.3.22/konva.min.js>

```sh
curl -fsSL https://cdn.jsdelivr.net/npm/konva@9.3.22/konva.min.js -o static/vendor/konva.min.js
```

QRious 4.0.2 — <https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js>

```sh
curl -fsSL https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js -o static/vendor/qrious.min.js
```

jsPDF 2.5.1 — <https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js>

```sh
curl -fsSL https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js -o static/vendor/jspdf.umd.min.js
```

After a refresh, update BOTH the byte size and the SHA-256 in the table above, and confirm
the file really is the library (the license header / UMD preamble) — a captive-portal HTML
page saved under a `.js` name would otherwise ship silently. `ci/smoke.py` checks a size
floor and a content marker per file (`Konva JavaScript Framework`, `QRious`, `jspdf={}`), so
a refresh that drops one of those markers turns the gate red. The jsPDF marker is the UMD
global assignment rather than the product name on purpose: it is absent from the ESM build,
so it catches a refresh that grabs the wrong bundle of the right library.
