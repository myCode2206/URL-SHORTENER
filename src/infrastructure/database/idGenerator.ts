import type { Database } from './prisma';

// Where unique IDs come from. The URL service depends only on this interface,
// so the source can change without touching business logic:
//
// - Now: one PostgreSQL sequence. Simple, gap-tolerant, and never repeats a
//   value, even with many app servers inserting at once.
// - Later, if writes outgrow one primary database or IDs are needed without a
//   database round trip: a Snowflake-style generator (timestamp + machine ID +
//   per-machine counter), or ranges of IDs reserved in blocks of 1,000 per server.
export interface IdGenerator {
  nextId(): Promise<bigint>;
}

export class PostgresSequenceIdGenerator implements IdGenerator {
  constructor(private readonly db: Database) {}

  async nextId(): Promise<bigint> {
    // Reserves the next value of the sequence behind urls.id. nextval() is
    // atomic and never handed out twice, even if the transaction that asked
    // for it rolls back. That can leave gaps, which is harmless.
    const [row] = await this.db.$queryRaw<{ id: bigint }[]>`
      SELECT nextval(pg_get_serial_sequence('urls', 'id')) AS id`;
    if (!row) throw new Error('sequence returned no value');
    return row.id;
  }
}
