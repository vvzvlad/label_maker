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

Vendoring removes the dependency entirely: `/render.html` and its whole module graph now
reference no external host at all, so a render touches nothing but the container itself.
`ci/smoke.py` enforces this — it serves the assets, guards against an external
`<script src="https://…">` creeping back into `render.html`, and renders a real PDF
end to end on the backend image.

Both pages load these files from `/vendor/`: `static/render.html` (the offline renderer)
and `static/index.html` (the public web UI).

## Contents

| File | Library | Version | Bytes |
| --- | --- | --- | --- |
| `konva.min.js` | Konva | 9.3.22 | 175354 |
| `qrious.min.js` | QRious | 4.0.2 | 17579 |
| `jspdf.umd.min.js` | jsPDF (UMD bundle) | 2.5.1 | 364463 |

The files are byte-identical to upstream — no reformatting, no added header comments — so
they can be re-verified at any time by re-running the download and comparing.

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

After a refresh, check the byte size against the table above and confirm the file really is
the library (the license header / UMD preamble) — a captive-portal HTML page saved under a
`.js` name would otherwise ship silently.
