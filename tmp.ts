import * as net from 'net';

function soWrite(socket: net.Socket, data: Buffer): Promise<void> {
  console.assert(data.length > 0);
  return new Promise((resolve, reject) => {
    socket.write(data, (err?: Error) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function soRead(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.on('data', (data: Buffer) => {
      if (!data) {
        reject();
      } else {
        resolve(data);
      }
    });
  });
}

async function newConn(socket: net.Socket): Promise<void> {
  console.log('new connection', socket.remoteAddress, socket.remotePort);

  try {
    while (true) {
      let data = await soRead(socket);
      if (data.length === 0) {
        console.log('end connection');
        break;
      }

      console.log('data', data);
      await soWrite(socket, data);
    }
  } catch (exc) {
    console.error('exception:', exc);
  } finally {
    socket.destroy();
  }
}

let server = net.createServer();
server.on('error', (err: Error) => {
  throw err;
});
server.on('connection', newConn);
server.listen({ host: '127.0.0.1', port: 1234 });

// function soRead(conn: TCPConn): Promise<Buffer>;
// function soWrite(conn: TCPConn, data: Buffer): Promise<void>;
