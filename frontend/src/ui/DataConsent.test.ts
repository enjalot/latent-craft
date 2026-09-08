import { afterEach, expect, it, vi } from "vitest";
import { copyMapUrl } from "./DataConsent.ts";

afterEach(() => vi.unstubAllGlobals());

it("uses HTTPS clipboard without selecting a fallback field", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined), focus = vi.fn();
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  expect(await copyMapUrl("https://map.test/?dataset=dino", { focus } as unknown as HTMLInputElement)).toBe(true);
  expect(writeText).toHaveBeenCalledWith("https://map.test/?dataset=dino");
  expect(focus).not.toHaveBeenCalled();
});

it("supports plain HTTP and leaves a selected URL for manual copying if permission is denied", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) } });
  const execCommand = vi.fn().mockReturnValue(false);
  vi.stubGlobal("document", { execCommand });
  const field = { value: "", focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn() };
  expect(await copyMapUrl("http://gsv.local:5300/", field as unknown as HTMLInputElement)).toBe(false);
  expect(field.value).toBe("http://gsv.local:5300/");
  expect(field.setSelectionRange).toHaveBeenCalledWith(0, field.value.length);
  expect(execCommand).toHaveBeenCalledWith("copy");
  vi.stubGlobal("navigator", {}); execCommand.mockReturnValue(true);
  expect(await copyMapUrl(field.value, field as unknown as HTMLInputElement)).toBe(true);
});
