import { createServer, type Server } from 'node:http';
import { errorFields } from '../log.ts';
import type { App } from './app.ts';
import { handleRequest } from './pipeline.ts';

export function createApiServer(app: App): Server {
  const server = createServer((req, res) => {
    handleRequest(app, req, res).catch((err) => {
      app.log.error('response failed', errorFields(err));
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":{"code":"internal_error","message":"An unexpected error occurred."}}');
    });
  });
  server.keepAliveTimeout = 65_000;
  server.on('clientError', (_err, socket) => socket.destroy());

  return server;
}

export function closeServer(server: Server, graceMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => server.closeAllConnections(), graceMs);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}
