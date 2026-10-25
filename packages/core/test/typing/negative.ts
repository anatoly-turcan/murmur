import { Command, Handle, Piece, Query, Serve, type InputOf, type OutputOf, type Rejection } from 'murmur';
import { z } from 'zod';

import type { AdminGrant } from '../fixtures/v2/contracts/auth.ts';
import {
  Authenticate,
  type Principal,
  RateLimit,
  RequireAdmin,
  ResolveTarget,
  type Scope,
} from '../fixtures/v2/contracts/auth.ts';
import {
  CreateTodo,
  GetTodo,
  ListTodos,
  type Todo,
  TodoCreated,
  TodoRemoved,
} from '../fixtures/v2/contracts/todos.ts';
import web, { kv, open, sqlite, type WebRequest } from './capabilities.ts';
import type { HttpRequest } from './http.ts';

class Owner extends Query({ id: z.string() }, { name: z.string() }) {}

class SweepDue extends Command({}, {}) {}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

export class WrongOutputKey extends Piece() {
  @Handle(CreateTodo)
  async create(input: CreateTodo): Promise<Todo> {
    // @ts-expect-error spike 1: titel is not a key of Todo
    return { id: '1', titel: input.title, done: false };
  }
}

export class WrongInputType extends Piece() {
  // @ts-expect-error spike 2: the input is not the contract's input type
  @Handle(CreateTodo)
  async create(input: { title: number }): Promise<Todo> {
    return { id: '1', title: String(input.title), done: false };
  }
}

export class InputIsAnotherContract extends Piece() {
  // @ts-expect-error spike 3: GetTodo is not CreateTodo
  @Handle(CreateTodo)
  async create(input: GetTodo): Promise<Todo> {
    return { id: input.id, title: '', done: false };
  }
}

export class UnannotatedExtraKey extends Piece() {
  // @ts-expect-error spike 4: output has no key "extra"
  @Handle(CreateTodo)
  async create(input: CreateTodo) {
    return { id: '1', title: input.title, done: false, extra: 1 };
  }
}

export class UnannotatedMissingKey extends Piece() {
  // @ts-expect-error spike 5: done is missing
  @Handle(CreateTodo)
  async create(input: CreateTodo) {
    return { id: '1', title: input.title };
  }
}

export class NullableOutputUndefined extends Piece() {
  // @ts-expect-error spike 6: undefined is not Todo | null
  @Handle(GetTodo)
  async get(_input: GetTodo) {
    return undefined;
  }
}

export class EventHandlerReturnsValue extends Piece() {
  // @ts-expect-error spike 7: an event handler returns nothing
  @Handle(TodoCreated)
  async created(_event: TodoCreated) {
    return 1;
  }
}

export class EmitUndeclared extends Piece({ emits: [TodoCreated] }) {
  @Handle(CreateTodo)
  async create(input: CreateTodo): Promise<Todo> {
    // @ts-expect-error spike 8: TodoRemoved is not declared in emits
    await this.emit(TodoRemoved, { id: '1' });

    return { id: '1', title: input.title, done: false };
  }
}

export class EmitWrongPayload extends Piece({ emits: [TodoCreated] }) {
  @Handle(CreateTodo)
  async create(input: CreateTodo): Promise<Todo> {
    // @ts-expect-error spike 9: id is a string
    await this.emit(TodoCreated, { id: 1, title: input.title });

    return { id: '1', title: input.title, done: false };
  }
}

// @ts-expect-error spike 10a: emits lists events only, GetTodo is a query
export class EmitsARequest extends Piece({ emits: [GetTodo] }) {
  @Handle(CreateTodo)
  async create(input: CreateTodo): Promise<Todo> {
    // @ts-expect-error spike 10b: emit takes an event contract
    await this.emit(GetTodo, { id: '1' });

    return { id: '1', title: input.title, done: false };
  }
}

export class UndeclaredCapability extends Piece({ needs: { db: sqlite } }) {
  @Handle(CreateTodo)
  async create(input: CreateTodo): Promise<Todo> {
    // @ts-expect-error spike 11: kv is not declared in needs
    await this.kv.get('x');

    return { id: '1', title: input.title, done: false };
  }
}

export class RouteWrongAuth extends Piece() {
  // @ts-expect-error spike 12: the route's auth is Principal & Quota, not AdminGrant
  @Serve(web.get('/todos/:id'))
  show(req: HttpRequest<AdminGrant>) {
    return { admin: req.auth.admin };
  }
}

export class RouteParamIsOptional extends Piece() {
  @Serve(web.get('/todos'))
  show(req: WebRequest) {
    // @ts-expect-error spike 13 (v0.2): req.params is a plain record, a param may be absent
    const id: string = req.params.id;

    return { id };
  }
}

export class RouteReturnsDate extends Piece() {
  // @ts-expect-error spike 14: a Date is not a JSON result
  @Serve(web.get('/now'))
  now(_req: WebRequest) {
    return new Date();
  }
}

export class NoGuardsUsesAuth extends Piece() {
  @Serve(open.get('/health'))
  health(req: HttpRequest) {
    // @ts-expect-error spike 15 (v0.2): req.auth.userId with no guards
    return { user: req.auth.userId };
  }
}

// @ts-expect-error spike 16: path param :todoId is not a field of GetTodo's input
@Serve(web.get('/todos/:todoId'), GetTodo)
export class ShorthandParamNotInInput extends Piece() {}

export class EveryWithoutUnit extends Piece() {
  // @ts-expect-error spike 17: every is a duration with a unit, not a bare number
  @Handle(SweepDue, { every: '90' })
  async sweep(): Promise<void> {}
}

export class BatchOptionGone extends Piece() {
  // @ts-expect-error spike 17b: { batch } is no Handle option; every and retry are
  @Handle(Owner, { batch: true })
  async owners(input: Owner) {
    return { name: input.id };
  }
}

export class VoidForAModelOutput extends Piece() {
  // @ts-expect-error spike 17c: only a command whose output accepts {} may return nothing
  @Handle(CreateTodo)
  async create(): Promise<void> {}
}

export class AnnotatedExtraKeyLiteral extends Piece() {
  @Handle(CreateTodo)
  async create(input: CreateTodo): Promise<Todo> {
    // @ts-expect-error spike 20: extra is not a key of Todo
    return { id: '1', title: input.title, done: false, extra: true };
  }
}

export class SkippedGuardStillUsesItsAuth extends Piece() {
  // @ts-expect-error v1: req: WebRequest on a route with skip: [Authenticate]
  @Serve(web.get('/stats', { skip: [Authenticate] }))
  stats(req: WebRequest) {
    return { user: req.auth.userId };
  }
}

export class FullySkippedUsesAuth extends Piece() {
  @Serve(web.get('/open', { skip: [Authenticate, RateLimit] }))
  health(req: HttpRequest) {
    // @ts-expect-error v1: req.auth.userId with every guard skipped
    return { user: req.auth.userId };
  }
}

export class ExtraGuardNeedsItsAuth extends Piece() {
  // @ts-expect-error v1: a route guard adds AdminGrant, WebRequest lacks it
  @Serve(web.get('/admin', { guards: [RequireAdmin] }))
  admin(req: WebRequest) {
    return { user: req.auth.userId };
  }

  @Serve(web.get('/admin/ok', { guards: [RequireAdmin] }))
  adminOk(req: HttpRequest<Principal & { remaining: number } & AdminGrant>) {
    return { admin: req.auth.admin };
  }
}

export class ConfigTyping extends Piece({ config: { perMinute: z.number().default(60), name: z.string() } }) {
  @Handle(GetTodo)
  async get(input: GetTodo) {
    const perMinute: number = this.config.perMinute;
    // @ts-expect-error v1 config: perMinute is a number
    const wrong: string = this.config.perMinute;
    // @ts-expect-error v1 config: undeclared config key
    void this.config.taxRate;
    void [perMinute, wrong];

    return { id: input.id, title: this.config.name, done: false };
  }
}

export class NoConfigDeclared extends Piece() {
  @Handle(GetTodo)
  async get(_input: GetTodo) {
    // @ts-expect-error v1 config: no config declared
    void this.config.anything;

    return null;
  }
}

// @ts-expect-error v1: a needs value must be a capability token
export class NeedsANonToken extends Piece({ needs: { db: 'sqlite' } }) {}

export class RequestAnEvent extends Piece() {
  @Handle(GetTodo)
  async get(_input: GetTodo) {
    // @ts-expect-error v1: an event is not requestable
    await this.request(TodoCreated, { id: '1', title: 'x' });

    return null;
  }
}

export class RequestWrongInput extends Piece() {
  @Handle(ListTodos)
  async list(_input: ListTodos) {
    // @ts-expect-error v1: GetTodo needs an id
    return [await this.request(GetTodo, {})].filter((todo) => todo !== null);
  }
}

export class GuardReturnsWrongModel extends Piece() {
  // @ts-expect-error v1: a guard answers its model or a Rejection
  @Handle(Authenticate)
  async authenticate(_input: Authenticate) {
    return { remaining: 1 };
  }
}

export class CapabilitiesAreTyped extends Piece({ needs: { db: sqlite, store: kv } }) {
  @Handle(GetTodo)
  async get(input: GetTodo) {
    // @ts-expect-error v1: the kv handle has no run()
    await this.store.run('x');
    await this.db.run('x', input.id);

    return null;
  }
}

const inputIsSchemaInput: Equal<InputOf<typeof ListTodos>, { done?: boolean | undefined }> = true;
const outputIsNullable: Equal<OutputOf<typeof GetTodo>, Todo | null> = true;
const eventOutputIsVoid: Equal<OutputOf<typeof TodoCreated>, void> = true;
const guardOutput: Equal<OutputOf<typeof Authenticate>, Principal | Rejection> = true;

void [inputIsSchemaInput, outputIsNullable, eventOutputIsVoid, guardOutput];

export class GuardReadsPriorAndMeta extends Piece() {
  @Handle(ResolveTarget)
  async resolve(input: ResolveTarget): Promise<Scope | Rejection> {
    const user: string = input.prior.userId;
    const remaining: number | undefined = input.prior.remaining;
    const role: 'viewer' | 'member' = input.meta.role;
    // @ts-expect-error v0.3: an optional guard's output may be absent
    const sure: number = input.prior.remaining;
    // @ts-expect-error v0.3: AdminGrant is neither in after nor in optional
    void input.prior.admin;
    void [remaining, sure];

    return { role, target: `${input.meta.target}:${user}:${input.ip}` };
  }
}
