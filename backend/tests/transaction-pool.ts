import type { Pool, PoolClient } from 'pg';
// Adapt a test-owned rollback transaction to repositories that acquire a connection.
// Savepoints exercise the real transaction path without committing fixture data.
export function transactionPool(client: PoolClient): Pool {
  return {
    query: client.query.bind(client),
    connect: async () => ({
      query: (text: string, values?: unknown[]) => client.query(
        text === 'BEGIN' ? 'SAVEPOINT repository_test' : text === 'COMMIT' ? 'RELEASE SAVEPOINT repository_test' :
          text === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT repository_test' : text, values),
      release() {},
    }),
  } as unknown as Pool;
}
