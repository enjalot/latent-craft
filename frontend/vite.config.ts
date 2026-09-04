import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  server: {
    host: true,
    port: 5300,
    // Vite blocks requests whose Host header it doesn't recognise (DNS-rebinding
    // guard). The whole point of `host: true` here is previewing from a phone or
    // laptop on the LAN via mDNS, so the machine's .local name has to be allowed
    // explicitly or those devices get a 403 instead of the app.
    allowedHosts: ["gsv.local", ".local"],
    // Proxy chunk-pack requests to the static data server (port 8802) through
    // Vite's own Node process rather than having the browser fetch it directly.
    // A direct browser fetch from :5300 to :8802 — even same-host, even with
    // CORS headers — gets blocked by Chrome's Private/Local Network Access
    // policy ("request client is not a secure context and the resource is in
    // more-private address space `local`") once the page is loaded over plain
    // http from a non-localhost hostname like gsv.local. Proxying makes the
    // browser see one same-origin server; only Vite's Node process (not
    // subject to browser PNA rules) talks to :8802.
    proxy: {
      "/chunks": "http://localhost:8802",
      // Per-point full-resolution thumbnails (mining/inventory) — resolve a
      // row_id to a URL via point_index.bin (subset_code/local_idx) + the
      // manifest's thumb_url_template, then fetch it at /thumbs/<that path>.
      // Two families share this one proxy rule: BL is static files (a symlink
      // on the data-server side, /data/latent-scope-3d/thumbs/bl ->
      // /data/images/british-library-book-images/thumbs); MONET is a dynamic
      // route in data_server.py (/thumbs/monet/<packed>.webp) that slices one
      // thumbnail out of the packed per-shard blobs.
      "/thumbs": "http://localhost:8802",
      // 2D minimap pack (Phase 5) — same static data server, same proxy reason
      // as /chunks and /thumbs above (Chrome Private/Local Network Access).
      "/minimap": "http://localhost:8802",
      // Per-row original-image lookup (lightbox originals) — the data server's
      // dynamic /meta/<points_id>/<row_id> route over point_meta.bin, which
      // answers {url, width, height} for one row so the lightbox can fetch
      // the full-resolution original behind a thumbnail. Same proxy reason
      // as the three above. Note <points_id> is the POINTS TABLE (bl,
      // monet-random, …), not the chunk-pack id — see DatasetConfig.pointsId.
      "/meta": "http://localhost:8802",
    },
  },
});
