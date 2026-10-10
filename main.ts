import * as net from 'net';
import type { DynBuf } from './dynamicBuff.ts';
import type { HTTPReq, HTTPRes, BodyReader } from './http.ts';
import type { TCPConn } from './socket.ts';
import { bufPush } from './dynamicBuff.ts';
import {
  cutMessage,
  HTTPError,
  handleReq,
  readerFromMemory,
  readerFromReq,
  writeHTTPResp,
} from './http.ts';
import { soInit, soRead } from './socket.ts';

async function newConn(socket: net.Socket): Promise<void> {
  console.log('new connection', socket.remoteAddress, socket.remotePort);
  const conn: TCPConn = soInit(socket);

  try {
    await serveClient(conn);
  } catch (exc) {
    console.log('exception:', exc);
    if (exc instanceof HTTPError) {
      // intended to send an error response
      const resp: HTTPRes = {
        code: exc.code,
        headers: [],
        body: readerFromMemory(Buffer.from(exc.message + '\n')),
      };
      try {
        await writeHTTPResp(conn, resp);
      } catch (exc) {
        /* ignore */
      }
    }
  } finally {
    socket.destroy();
  }
}

// echo server
async function serveClient(conn: TCPConn): Promise<void> {
  const buf: DynBuf = { data: Buffer.alloc(0), length: 0, dataStart: 0 };

  while (true) {
    // try to get 1 message from buffer
    const msg: null | HTTPReq = await cutMessage(buf);
    if (!msg) {
      // need more data
      const data = await soRead(conn);
      bufPush(buf, data);
      // EOF?
      if (data.length === 0 && buf.length === 0) {
        return; // no more requests
      }
      if (data.length === 0) {
        throw new HTTPError(400, 'Unexpected EOF');
      }
      // got some data, try it again.
      continue;
    }

    // process the message and send the response
    const reqBody: BodyReader = readerFromReq(conn, buf, msg);
    const res: HTTPRes = await handleReq(msg, reqBody);
    await writeHTTPResp(conn, res);

    // close the connection for HTTP/1.0
    if (msg.version === '1.0') {
      return;
    }

    //make sure that the request body is consumed completely
    while ((await reqBody.read()).length > 0) {
      /* empty */
    }
  } // loop for IO
}

let server = net.createServer({
  pauseOnConnect: true,
});
server.on('connection', newConn);
server.on('error', (err) => {
  throw err;
});
server.listen({ host: '127.0.0.1', port: 1234 });
