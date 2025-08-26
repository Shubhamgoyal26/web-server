import { bufPop } from './dynamicBuff.ts';
import type { DynBuf } from './dynamicBuff.ts';

// the maximum length of an HTTP header
const kMaxHeaderLen = 1024 * 8;

// a parsed HTTP request header
type HTTPReq = {
  method: string;
  uri: Buffer;
  version: string;
  headers: Buffer[];
};

// an HTTP response
type HTTPRes = {
  code: number;
  headers: Buffer[];
  body: BodyReader;
};

// an interface for reading/writing data from/to the HTTP body.
type BodyReader = {
  // the "Content-Length", -1 if unknown.
  length: number;
  // read data. returns an empty buffer after EOF.
  read: () => Promise<Buffer>;
};

class HTTPError extends Error {
  code: Number;
  constructor(httpCode: Number, message: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = httpCode;
  }
}

// parse & remove a header from the beginning of the buffer if possible
function cutMessage(buf: DynBuf): null | HTTPReq {
  // the end of the header is marked by '\r\n\r\n'
  const idx = buf.data.subarray(buf.dataStart, buf.length).indexOf('\r\n\r\n');
  if (idx < 0) {
    if (buf.length >= kMaxHeaderLen) {
      throw new HTTPError(413, 'header is too large');
    }
    return null; // need more data
  }

  // parse and remove the header
  const msg = parseHTTPReq(
    buf.data.subarray(buf.dataStart, buf.dataStart + idx + 4)
  );
  buf.dataStart += idx + 4;

  if (buf.dataStart > buf.data.length / 2) {
    bufPop(buf);
  }

  return msg;
}

function splitLines(data: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;

  while (start < data.length - 2) {
    let end = data.subarray(start).indexOf('\r\n');
    let line = Buffer.from(data.subarray(start, start + end));
    start += end + 2;
    lines.push(line);
  }

  if (lines.length <= 2) {
    throw new HTTPError(400, 'insufficient headers');
  }

  return lines;
}

function parseRequestLine(line: Buffer): Buffer[] {
  const firstCut = line.indexOf(' ');
  const secondCut = firstCut + line.subarray(firstCut + 1).indexOf(' ') + 1;

  const method = line.subarray(0, firstCut);
  const uri = line.subarray(firstCut + 1, secondCut + 1);
  const version = line.subarray(secondCut + 1, line.length);

  if (method.length === 0 || uri.length === 0 || version.length === 0) {
    throw new HTTPError(400, 'bad request');
  }

  return [method, uri, version];
}

function validateHeader(header: Buffer): Boolean {
  const headerNameCharRegex = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
  const headerValueCharRegex = /[^\t\x20-\x7e\x80-\xff]/;
  const idx = header.indexOf(':');
  if (idx < 0) {
    return false;
  }
  const name = header.subarray(0, idx);
  const value = header.subarray(idx + 1);

  if (
    name == null ||
    name.length == 0 ||
    !headerNameCharRegex.test(name.toString())
  ) {
    return false;
  }

  if (
    value == null ||
    value.length == 0 ||
    headerValueCharRegex.test(value.toString())
  ) {
    return false;
  }

  return true;
}

// parse an HTTP request header
function parseHTTPReq(data: Buffer): HTTPReq {
  // split the data into lines
  const lines: Buffer[] = splitLines(data);
  // the first line is 'METHOD URI VERSION'
  const [method, uri, version] = parseRequestLine(lines[0]);
  // followed by header fields in the format of `Name: value`
  const headers: Buffer[] = [];
  for (let i = 1; i < lines.length - 1; i++) {
    const h = Buffer.from(lines[i]); // copy
    if (!validateHeader(h)) {
      throw new HTTPError(400, 'bad field');
    }
    headers.push(h);
  }

  // the header ends by an empty line
  console.assert(lines[lines.length - 1].length === 0);
  return {
    method: method.toString(),
    uri: uri,
    version: version.toString(),
    headers: headers,
  };
}

export { cutMessage, HTTPError };
export type { HTTPReq, HTTPRes };
