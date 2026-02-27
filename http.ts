import { bufPop, bufPush } from './dynamicBuff.ts';
import type { DynBuf } from './dynamicBuff.ts';
import type { TCPConn } from './socket.ts';
import { soWrite, soRead } from './socket.ts';

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
  code: Number;
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

function parseHeader(header: Buffer): null | Buffer[] {
  const idx = header.indexOf(':');
  if (idx < 0) {
    return null;
  }
  const name = header.subarray(0, idx);
  const value = header.subarray(idx + 1);

  if (name.length === 0 || value.length === 0) {
    throw new HTTPError(400, 'bad header');
  }

  return [name, value];
}

function validateHeader(header: Buffer): Boolean {
  const headerNameCharRegex = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
  const headerValueCharRegex = /[^\t\x20-\x7e\x80-\xff]/;

  const parsedHeader = parseHeader(header);
  if (parseHeader == null) {
    return false;
  }
  const name = parsedHeader[0];
  const value = parsedHeader[1];

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

function fieldGet(headers: Buffer[], key: string): null | Buffer {
  for (let i = 0; i < headers.length; i++) {
    let parsedHeader = parseHeader(headers[i]);
    if (parsedHeader == null) {
      continue;
    }
    if (parsedHeader[0].toString().toLowerCase() === key.toLowerCase()) {
      return parsedHeader[1];
    }
  }
  return null;
}

// BodyReader from an HTTP request
function readerFromReq(conn: TCPConn, buf: DynBuf, req: HTTPReq): BodyReader {
  let bodyLen = -1;
  const contentLen = fieldGet(req.headers, 'Content-Length');
  if (contentLen) {
    bodyLen = parseInt(contentLen.toString('latin1'), 10);
    if (isNaN(bodyLen)) {
      throw new HTTPError(400, 'bad content-length.');
    }
  }
  const bodyAllowed = !(req.method === 'GET' || req.method === 'HEAD');
  const chunked =
    fieldGet(req.headers, 'Transfer-Encoding')?.equals(
      Buffer.from('chunked')
    ) || false;

  if (!bodyAllowed && (bodyLen > 0 || chunked)) {
    throw new HTTPError(400, 'HTTP body not allowed.');
  }
  if (!bodyAllowed) {
    bodyLen = 0;
  }

  if (bodyLen >= 0) {
    // Content-Length is present
    return readerFromConnLength(conn, buf, bodyLen);
  } else if (chunked) {
    // chunked encoding
    throw new HTTPError(501, 'TODO');
  } else {
    // read the rest of the connection
    throw new HTTPError(501, 'TODO');
  }
}

// BodyReader from a socket with a known length
function readerFromConnLength(
  conn: TCPConn,
  buf: DynBuf,
  remain: number
): BodyReader {
  return {
    length: remain,
    read: async (): Promise<Buffer> => {
      if (remain == 0) {
        return Buffer.from(''); // done
      }
      if (buf.length === 0) {
        // try to get some data if there is none
        const data = await soRead(conn);
        bufPush(buf, data);
        // expect more data!
        throw new Error('Unexpected EOF from HTTP body');
      }

      // consume data from the buffer
      const consume = Math.min(buf.length, remain);
      remain -= consume;
      const data = Buffer.from(buf.data.subarray(0, consume));
      bufPop(buf, consume);
      return data;
    },
  };
}

// a sample request handler
async function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
  // act on the request URI
  let resp: BodyReader;
  switch (req.uri.toString('latin1')) {
    case '/echo':
      // http echo server
      resp = body;
      break;
    default:
      resp = readerFromMemory(Buffer.from('hello world.\n'));
      break;
  }

  return {
    code: 200,
    headers: [Buffer.from('Server: my_first_http_server')],
    body: resp,
  };
}

// BodyReader from in-memory data
function readerFromMemory(data: Buffer): BodyReader {
  let done = false;
  return {
    length: data.length,
    read: async (): Promise<Buffer> => {
      if (done) {
        return Buffer.from(''); // no more data
      } else {
        done = true;
        return data;
      }
    },
  };
}

function encodeHTTPResp(resp: HTTPRes): Buffer[] {
  let responseHeaders: Buffer[] = [];
  const statusLine = Buffer.from(`HTTP/1.1 ${resp.code} OK\r\n`);
  responseHeaders.push(statusLine);
  for (let i = 0; i < resp.headers.length; i++) {
    responseHeaders.push(resp.headers[i]);
  }

  return responseHeaders;
}

// send an HTTP response through the socket
async function writeHTTPResp(conn: TCPConn, resp: HTTPRes): Promise<void> {
  if (resp.body.length < 0) {
    throw new Error('TODO: chunked encoding');
  }
  // set the "Content-Length" field
  console.assert(!fieldGet(resp.headers, 'Content-Length'));
  resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));

  // write the header
  await soWrite(conn, encodeHTTPResp(resp));
  // write the body
  while (true) {
    const data = await resp.body.read();
    if (data.length === 0) {
      break;
    }
    await soWrite(conn, data);
  }
}

export {
  cutMessage,
  HTTPError,
  handleReq,
  readerFromReq,
  readerFromMemory,
  writeHTTPResp,
};
export type { HTTPReq, HTTPRes, BodyReader };
