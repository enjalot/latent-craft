import { describe, expect, it } from "vitest";
import { allocateProxyBricks, proxyBrickLod, selectProxyCut } from "./ProxyCut.ts";

describe("balanced proxy coverage", () => {
  it("reserves all near gray coverage before refining any brick", () => {
    const leaves = Array.from({length: 150}, () => ({counts:[64,512,4096],lod:2}));
    const levels = allocateProxyBricks(leaves);
    expect(levels).toHaveLength(128);
    expect(levels.reduce((sum,lod,i)=>sum+leaves[i].counts[lod],0)).toBeLessThanOrEqual(65536);
    expect(levels[0]).toBe(2); expect(levels.at(-1)).toBe(0);
    // Allocation has no cache state: delayed nearer bricks reserve their slots.
    expect(allocateProxyBricks(leaves)).toEqual(levels);
  });
  it("never lets a cheaper far brick jump a nearer coverage reservation", () => {
    expect(allocateProxyBricks([{counts:[60,80,100],lod:2},{counts:[60,80,100],lod:2},
      {counts:[1,2,3],lod:2}],128,100)).toEqual([2]);
  });
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
  it("keeps detail steady during small forward/back movements at a LOD boundary", () => {
    let lod=2;
    for (const distance of [2.05,1.99,2.1,2.02]) {
      lod=proxyBrickLod(distance,10,lod);expect(lod).toBe(2);
    }
    expect(proxyBrickLod(2.21,10,lod)).toBe(1);
    expect(proxyBrickLod(4.1,4,1)).toBe(1);
    expect(proxyBrickLod(4.3,4,1)).toBe(0);
  });
});
