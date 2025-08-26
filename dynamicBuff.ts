// A dynamic-sized buffer
type DynBuf = {
  data: Buffer;
  length: number;
  dataStart: number;
};

// append data to DynBuf
function bufPush(buf: DynBuf, data: Buffer): void {
  const newLen = buf.length + data.length;
  if (buf.data.length < newLen) {
    // grow the capacity by power of two
    let cap = Math.max(buf.data.length, 32);
    while (cap <= newLen) {
      cap *= 2;
    }
    const grown = Buffer.alloc(cap);
    buf.data.copy(grown, 0, 0);
    buf.data = grown;
  }
  data.copy(buf.data, buf.length, 0);
  buf.length = newLen;
}

// remove data from the front
function bufPop(buf: DynBuf): void {
  buf.data.copyWithin(0, buf.dataStart, buf.length);
  buf.length -= buf.dataStart;
  buf.dataStart = 0;
}

export { bufPush, bufPop };

export type { DynBuf };
