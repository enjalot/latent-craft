import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const dataTarget = env.LSV_DATA_PROXY_TARGET || "http://localhost:8802";
  return {
    root: ".",
    plugins: [{ name: "publication-profile", generateBundle() {
      this.emitFile({ type: "asset", fileName: "build-profile.json", source: JSON.stringify({
        dataset: env.VITE_DEMO_DATASET || null, dataOrigin: env.VITE_DATA_ORIGIN || "",
        thumbnailPack: env.VITE_THUMB_PACK_URL || "", monetThumbnailPack: env.VITE_MONET_THUMB_PACK_URL || "",
        thumbnailOrigin: env.VITE_THUMBS_ORIGIN ?? env.VITE_DATA_ORIGIN ?? "",
      }) });
    } }],
    server: {
      host: true,
      port: 5300,
      // Vite blocks requests whose Host header it doesn't recognise
      // (DNS-rebinding guard). The whole point of `host: true` here is
      // previewing from another device on the LAN via mDNS.
      allowedHosts: ["gsv.local", ".local"],
      // Keep browser requests same-origin and let Vite talk to the data
      // server. `LSV_DATA_PROXY_TARGET` makes the server location deployable
      // without changing source.
      proxy: {
        "/api/thumb-preview": "http://127.0.0.1:8808",
        "/api/metadata": env.LSV_METADATA_PROXY_TARGET || "http://127.0.0.1:8805",
        "/api/bl": env.LSV_BL_SEARCH_PROXY_TARGET || "http://127.0.0.1:8804",
        "/api/monet": env.LSV_MONET_SEARCH_PROXY_TARGET || "http://127.0.0.1:8807",
        "/api/explore": env.LSV_SEARCH_PROXY_TARGET || "http://127.0.0.1:8803",
        "/chunks": dataTarget,
        // BL thumbnails are static files; MONET thumbnails use the data
        // server's dynamic packed-blob route.
        "/thumbs": dataTarget,
        "/thumb-packs": dataTarget,
        "/minimap": dataTarget,
        "/points": dataTarget,
        // Per-row original-image lookup used by the lightbox.
        "/meta": dataTarget,
      },
    },
  };
});
