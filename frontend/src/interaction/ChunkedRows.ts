/** Append-friendly u32 inventory. Pages grow up to 4K, avoiding boxed numbers and full
 * array copies. Returns compact just one page; UI/lightbox address logical indices. */
export class ChunkedRows {
  private readonly pages: { data: Uint32Array; used: number; start: number }[] = [];
  length = 0;
  push(row: number): void {
    let page = this.pages[this.pages.length - 1];
    if (!page || page.used === 4096) {
      page = { data: new Uint32Array(16), used: 0, start: this.length };
      this.pages.push(page);
    }
    if (page.used === page.data.length) {
      const data = new Uint32Array(Math.min(4096, page.data.length * 2));
      data.set(page.data);
      page.data = data;
    }
    page.data[page.used++] = row;
    this.length++;
  }
  at(index: number): number | undefined {
    if (index < 0) index += this.length;
    if (index < 0 || index >= this.length) return undefined;
    let low = 0, high = this.pages.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2), page = this.pages[mid];
      if (index < page.start) high = mid - 1;
      else if (index >= page.start + page.used) low = mid + 1;
      else return page.data[index - page.start];
    }
    return undefined;
  }
  indexOf(row: number): number {
    for (const page of this.pages) {
      const local = page.data.subarray(0, page.used).indexOf(row);
      if (local >= 0) return page.start + local;
    }
    return -1;
  }
  remove(row: number): boolean {
    let found = false;
    for (const page of this.pages) {
      if (found) { page.start--; continue; }
      const local = page.data.subarray(0, page.used).indexOf(row);
      if (local < 0) continue;
      page.data.copyWithin(local, local + 1, page.used--);
      this.length--;
      found = true;
    }
    return found;
  }
  slice(start = 0, end = this.length): number[] {
    const result: number[] = [];
    for (let i = Math.max(0, start); i < Math.min(end, this.length); i++) result.push(this.at(i)!);
    return result;
  }
  *[Symbol.iterator](): IterableIterator<number> {
    for (const page of this.pages) for (let i = 0; i < page.used; i++) yield page.data[i];
  }
  get byteLength(): number { return this.pages.reduce((sum, page) => sum + page.data.byteLength, 0); }
}
