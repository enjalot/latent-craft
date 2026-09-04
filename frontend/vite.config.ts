import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const dataTarget = env.LSV_DATA_PROXY_TARGET || "http://localhost:8802";
  return {
    root: ".",
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
        "/chunks": dataTarget,
        // BL thumbnails are static files; MONET thumbnails use the data
        // server's dynamic packed-blob route.
        "/thumbs": dataTarget,
        "/minimap": dataTarget,
        // Per-row original-image lookup used by the lightbox.
        "/meta": dataTarget,
      },
    },
  };
});
