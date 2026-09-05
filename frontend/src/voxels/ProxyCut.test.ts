import { describe, expect, it } from "vitest";
import { proxyBrickLod, selectProxyCut } from "./ProxyCut.ts";

describe("balanced proxy coverage", () => {
  const tree = [{children:[1,2]}, {children:[3,4]}, {children:[5,6]},
    {children:[]}, {children:[]}, {children:[]}, {children:[]}];
  it("refines the more important sibling regardless of traversal order", () => {
    const scores = [1000,100,300,20,20,20,20];
    expect(selectProxyCut(tree, i => scores[i], 3).sort()).toEqual([1,5,6]);
    expect(selectProxyCut([{children:[2,1]},...tree.slice(1)], i => scores[i], 3).sort()).toEqual([1,5,6]);
  });
  it("retains parents at the budget, without holes or overlapping descendants", () => {
    for (let budget=1;budget<=7;budget++) {
      const cut=selectProxyCut(tree,()=>100,budget);
      expect(cut.length).toBeLessThanOrEqual(budget);
      for (const path of [[0,1,3],[0,1,4],[0,2,5],[0,2,6]])
        expect(path.filter(id=>cut.includes(id))).toHaveLength(1);
    }
  });
  it("does not spend coverage on offscreen branches", () => {
    expect(selectProxyCut(tree,i=>i===1?-1:100,3).sort()).toEqual([5,6]);
    expect(selectProxyCut(tree,()=>-1)).toEqual([]);
  });
  it("keeps far-ahead bricks coarse even at high screen resolution", () => {
    expect(proxyBrickLod(6,100)).toBe(0);
    expect(proxyBrickLod(3,100)).toBe(1);
    expect(proxyBrickLod(1.8,100)).toBe(2);
    expect(proxyBrickLod(1.8,2)).toBe(0);
  });
});
