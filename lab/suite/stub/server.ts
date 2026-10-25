import { createServer, type ServerResponse } from 'node:http';

// Harness self-test target: only /healthz and POST /__test/reset work; everything else is 501.

const port = Number(process.env.STUB_PORT ?? 18080);

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();

    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') return send(res, 200, { status: 'ok', database: 'ok' });
    if (req.method === 'POST' && path === '/__test/reset') return send(res, 204);
    send(res, 501, { error: { code: 'not_implemented', message: `${req.method} ${path} is not implemented by the stub.` } });
  });
});

server.listen(port, '127.0.0.1', () => console.log(`stub listening on http://127.0.0.1:${port}`));

const stop = (): void => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
