import { z } from 'zod';

import type { ModelClass } from './model-class.ts';
import { invalidSchema } from './schema.ts';

export interface PagingOptions {
  readonly max?: number;
  readonly default?: number;
}

export interface PagingShape {
  readonly limit: z.ZodDefault<z.ZodNumber>;
  readonly cursor: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}

export interface PageOptions<F extends string> {
  readonly cursorField?: F;
}

export type PageOf<T, F extends string = 'next_cursor'> = { data: T[] } & { [K in F]: string | null };

const PAGING_DEFAULTS = { max: 100, default: 20 } as const;

function isCount(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function pagingBounds(options: PagingOptions): { max: number; fallback: number } {
  const max = options.max ?? PAGING_DEFAULTS.max;
  const fallback = options.default ?? Math.min(PAGING_DEFAULTS.default, max);
  const given = `Paging({ max: ${max}, default: ${fallback} })`;

  if (!isCount(max) || !isCount(fallback)) {
    throw invalidSchema(
      `${given}: max and default are positive integers, like Paging({ max: 100, default: 20 })`,
    );
  }

  if (fallback > max) {
    throw invalidSchema(
      `${given}: default is at most max, like Paging({ max: ${Math.max(max, fallback, PAGING_DEFAULTS.max)}, default: ${fallback} })`,
    );
  }

  return { max, fallback };
}

export function Paging(options: PagingOptions = {}): PagingShape {
  const { max, fallback } = pagingBounds(options);

  return {
    limit: z.number().int().min(1).max(max).default(fallback),
    cursor: z.string().nullable().default(null),
  };
}

export function Page<T, F extends string = 'next_cursor'>(
  model: ModelClass<T>,
  options: PageOptions<F> = {},
): z.ZodType<PageOf<T, F>> {
  const field = options.cursorField ?? 'next_cursor';

  return z
    .object({ data: z.array(model.schema), [field]: z.string().nullable() })
    .meta({ title: `Page(${model.name})` }) as never;
}
