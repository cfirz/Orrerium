# Vendored libraries

No build step, no npm dependencies — these files are committed as-is. To re-vendor,
download the same (or a newer) version from the URLs below and update this table.

| File | Library | Version | License | Source URL |
|---|---|---|---|---|
| `d3.v7.min.js` | D3 (full UMD bundle, global `d3`) | 7.9.0 | ISC ([LICENSE-d3](LICENSE-d3)) | https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js |
| `marked.esm.js` | marked (single-file ESM) | 16.4.2 | MIT ([LICENSE-marked](LICENSE-marked)) | https://cdn.jsdelivr.net/npm/marked@16/lib/marked.esm.js |

Why the full D3 bundle: the standalone `d3-force` module builds have a deep bare-import
dependency chain (dispatch, quadtree, timer, selection, drag, zoom, transition,
interpolate, ease, color) that only a bundler resolves. One committed file served
locally is the honest no-build answer; size is irrelevant on localhost.
