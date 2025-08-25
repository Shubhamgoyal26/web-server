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

function cutMessage(buf: DynBuf): null | Buffer {
  // messages are separated by '\n'
  const idx = buf.data.subarray(buf.dataStart, buf.length).indexOf('\n');
  if (idx < 0) {
    return null; // not complete
  }
  // make a copy of the message and move the remaining data to the front
  const msg = Buffer.from(
    buf.data.subarray(buf.dataStart, buf.dataStart + idx + 1)
  );
  buf.dataStart += idx + 1;

  if (buf.dataStart > buf.data.length / 2) {
    bufPop(buf);
  }

  return msg;
}

export { bufPush, cutMessage };

export type { DynBuf };
