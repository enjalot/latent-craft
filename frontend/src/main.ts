import { runtimeProfile } from "./runtime/DeviceProfile.ts";
import { requestDataConsent } from "./ui/DataConsent.ts";
import "./ui/mobile.css";

const app = document.getElementById("app")!;
document.documentElement.dataset.mobile = String(runtimeProfile.mobile);
// Engine, theme assets and map fetches stay behind explicit touch-device consent.
async function start(): Promise<void> {
  if (runtimeProfile.mobile) await requestDataConsent(app);
  await import("./app.ts");
}
void start().catch(error => {
  const message = document.createElement("p"); message.className = "lc-boot-error";
  message.textContent = `Could not start the map: ${error instanceof Error ? error.message : String(error)}. Try a WebGL2-capable browser on a computer.`;
  app.append(message);
});
