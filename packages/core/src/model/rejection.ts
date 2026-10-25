import { z } from 'zod';

import type { OutputSpec, SpecOutput } from './contract-class.ts';
import { MurmurError } from './errors.ts';
import { isModel, Model } from './model-class.ts';
import { invalidSchema, isShape, isZodSchema } from './schema.ts';

type Details = Record<string, unknown> | Record<string, unknown>[];

const record = z.record(z.string(), z.unknown());

const REJECTION_SHAPE = {
  status: z.number().int().min(400).max(599),
  code: z.string().min(1),
  message: z.string(),
  details: z.union([record, z.array(record)]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
};

export class Rejection extends Model(REJECTION_SHAPE) {}

const exactRejection = z.strictObject(REJECTION_SHAPE);

export interface RejectOptions {
  readonly code?: string;
  readonly details?: Details;
  readonly headers?: Record<string, string>;
}

const CODES: Readonly<Record<number, string>> = {
  400: 'invalid_input',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'invalid_input',
  429: 'rate_limited',
};

export function codeForStatus(status: number): string {
  return CODES[status] ?? `http_${status}`;
}

function fieldsOf(status: number, message: string, options: RejectOptions): Record<string, unknown> {
  const { details, headers } = options;

  return {
    status,
    code: options.code ?? codeForStatus(status),
    message,
    ...(details === undefined ? {} : { details }),
    ...(headers === undefined ? {} : { headers }),
  };
}

export function reject(status: number, message: string, options: RejectOptions = {}): Rejection {
  const parsed = Rejection.schema.safeParse(fieldsOf(status, message, options));
  if (!parsed.success) {
    throw new MurmurError(`reject(${status}): ${z.prettifyError(parsed.error)}`, {
      code: 'invalid-rejection',
      retryable: false,
    });
  }

  return parsed.data;
}

export function isRejection(value: unknown): value is Rejection {
  return exactRejection.safeParse(value).success;
}

const rejectables = new WeakSet<z.ZodType>();

function outputSchema(output: OutputSpec): { schema: z.ZodType; label: string } {
  if (isModel(output)) {
    return { schema: output.schema, label: output.name };
  }

  if (isZodSchema(output)) {
    return { schema: output, label: output.meta()?.title ?? '…' };
  }

  if (isShape(output)) {
    return { schema: z.object(output), label: '{…}' };
  }

  throw invalidSchema('rejectable(): expected a Model class, a zod schema or a shape of zod schemas');
}

export function rejectable<O extends OutputSpec>(output: O): z.ZodType<SpecOutput<O> | Rejection> {
  const { schema, label } = outputSchema(output);
  const union = z.union([exactRejection, schema]).meta({ title: `rejectable(${label})` });
  rejectables.add(union);

  return union as never;
}

export function isRejectable(schema: unknown): boolean {
  return isZodSchema(schema) && rejectables.has(schema);
}
