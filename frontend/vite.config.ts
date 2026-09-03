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
    },
  },
});
