export interface Transaction extends AsyncDisposable {
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  commit(): Promise<void>;
}

export interface Postgres {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  transaction(): Promise<Transaction>;
}

export function fakePostgres(): { pg: Postgres; inserted: Record<string, unknown>[] } {
  const inserted: Record<string, unknown>[] = [];
  const pg: Postgres = {
    query: async () => [],
    transaction: async () => ({
      insert: async (_table, row) => {
        inserted.push(row);
      },
      commit: async () => {},
      [Symbol.asyncDispose]: async () => {},
    }),
  };

  return { pg, inserted };
}
