import { expect, it } from "vitest";
import { restoreFilterSettings } from "./FilterSettings.ts";
it("starts with the cutoff at two and filtering enabled", () => {
  expect(restoreFilterSettings()).toEqual({filterDefaultsVersion:2, filterEnabled:true, filterThreshold:2});
});
it("migrates the previous default once without erasing new or customized settings", () => {
  expect(restoreFilterSettings({filterEnabled:false,filterThreshold:1}).filterEnabled).toBe(true);
  expect(restoreFilterSettings({filterEnabled:false,filterThreshold:1,filterDefaultsVersion:2}).filterEnabled).toBe(false);
  expect(restoreFilterSettings({filterEnabled:false,filterThreshold:5})).toMatchObject({filterEnabled:false,filterThreshold:5});
});
