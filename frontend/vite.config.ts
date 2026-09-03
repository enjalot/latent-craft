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
  },
});
