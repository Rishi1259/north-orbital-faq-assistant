import {
  Pool,
  type PoolConfig,
} from 'pg';

export interface DatabaseConfig {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
}

export function createDatabasePool(
  config: DatabaseConfig,
): Pool {
  const poolConfig: PoolConfig = {
    connectionString:
      config.connectionString,

    max:
      config.max,

    connectionTimeoutMillis:
      config.connectionTimeoutMillis,

    idleTimeoutMillis:
      30_000,

    allowExitOnIdle:
      false,
  };

  return new Pool(
    poolConfig,
  );
}

export async function checkDatabase(
  pool: Pool,
): Promise<void> {
  const result =
    await pool.query<{
      value: number;
    }>(
      'SELECT 1 AS value',
    );

  if (
    result.rows[0]?.value !== 1
  ) {
    throw new Error(
      'Database readiness check failed.',
    );
  }
}

export async function closeDatabase(
  pool: Pool,
): Promise<void> {
  await pool.end();
}