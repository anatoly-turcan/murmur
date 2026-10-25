import { Handle, Piece, Serve } from 'murmur';

import web, { type WebRequest } from '../../../capabilities/web/capability.ts';
import { TodoCompleted, TodoCreated, TodoRemoved } from '../../../contracts/todos.ts';
import { sseFrame } from './frames.ts';

type Client = ReadableStreamDefaultController<Uint8Array>;

export class TodosFeed extends Piece() {
  private readonly clients = new Set<Client>();

  @Serve(web.get('/events/todos'))
  stream(req: WebRequest): Response {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.clients.add(controller);
        controller.enqueue(sseFrame('hello', { user: req.auth.userId }));
        req.signal.addEventListener('abort', () => {
          this.clients.delete(controller);
        });
      },
    });

    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  }

  @Handle(TodoCreated)
  created(event: TodoCreated): void {
    this.broadcast('created', event);
  }

  @Handle(TodoCompleted)
  completed(event: TodoCompleted): void {
    this.broadcast('completed', event);
  }

  @Handle(TodoRemoved)
  removed(event: TodoRemoved): void {
    this.broadcast('removed', event);
  }

  private broadcast(kind: string, data: object): void {
    const frame = sseFrame(kind, data);
    for (const client of this.clients) {
      this.send(client, frame);
    }
  }

  private send(client: Client, frame: Uint8Array): void {
    try {
      client.enqueue(frame);
    } catch {
      this.clients.delete(client);
    }
  }
}
