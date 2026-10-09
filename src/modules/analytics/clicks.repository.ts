import type { Database } from '../../infrastructure/database/prisma';
import type { ClickEvent } from './clickEvent';

// Column limits from the schema. Headers are client-controlled and can be any
// length, so they're cut to fit rather than failing the whole batch.
const MAX_USER_AGENT = 512;
const MAX_REFERRER = 2048;

export class ClicksRepository {
  constructor(private readonly db: Database) {}

  // Writes a batch of clicks in one transaction: one multi-row INSERT for the
  // events, and one UPDATE that adds each URL's new clicks to urls.click_count.
  // 500 clicks become 2 statements instead of 1,000.
  async insertBatch(events: ClickEvent[]): Promise<void> {
    if (events.length === 0) return;

    const countsByUrl = new Map<bigint, number>();
    for (const { urlId } of events) countsByUrl.set(urlId, (countsByUrl.get(urlId) ?? 0) + 1);
    // Rows are updated in ascending id order. If two servers flush at the same
    // time and both touch URLs 7 and 9, they lock them in the same order and
    // can't deadlock waiting on each other.
    const urlIds = [...countsByUrl.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const counts = urlIds.map((id) => countsByUrl.get(id) ?? 0);

    await this.db.$transaction([
      this.db.click.createMany({
        data: events.map((event) => ({
          urlId: event.urlId,
          clickedAt: event.clickedAt,
          userAgent: event.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
          referrer: event.referrer?.slice(0, MAX_REFERRER) ?? null,
        })),
      }),
      this.db.$executeRaw`
        UPDATE urls SET click_count = urls.click_count + batch.clicks
        FROM unnest(${urlIds}::bigint[], ${counts}::int[]) AS batch(id, clicks)
        WHERE urls.id = batch.id`,
    ]);
  }
}
