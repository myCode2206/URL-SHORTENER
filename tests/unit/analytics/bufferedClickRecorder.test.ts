import { BufferedClickRecorder } from '../../../src/modules/analytics/bufferedClickRecorder';
import type { ClickEvent } from '../../../src/modules/analytics/clickEvent';
import { createLogger } from '../../../src/utils/logger';
import { testLoggerConfig } from '../../helpers/silentLogger';

const logger = createLogger(testLoggerConfig);

function click(urlId: bigint): ClickEvent {
  return { urlId, clickedAt: new Date(), userAgent: null, referrer: null };
}

function setup(options = {}, insertBatch = jest.fn((_: ClickEvent[]) => Promise.resolve())) {
  const recorder = new BufferedClickRecorder({ insertBatch }, logger, options);
  return { recorder, insertBatch };
}

afterEach(() => jest.useRealTimers());

describe('BufferedClickRecorder', () => {
  it('returns immediately and writes nothing until flushed', () => {
    const { recorder, insertBatch } = setup();
    recorder.record(click(1n));
    expect(insertBatch).not.toHaveBeenCalled();
  });

  it('writes buffered clicks as one batch on flush', async () => {
    const { recorder, insertBatch } = setup();
    recorder.record(click(1n));
    recorder.record(click(2n));

    await recorder.flush();

    expect(insertBatch).toHaveBeenCalledTimes(1);
    expect(insertBatch.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('flushes on the timer', async () => {
    jest.useFakeTimers();
    const { recorder, insertBatch } = setup({ flushIntervalMs: 1000 });
    recorder.start();
    recorder.record(click(1n));

    await jest.advanceTimersByTimeAsync(1000);

    expect(insertBatch).toHaveBeenCalledTimes(1);
    await recorder.stop();
  });

  it('flushes early once a full batch is waiting', async () => {
    const { recorder, insertBatch } = setup({ maxBatchSize: 3 });
    for (let i = 0; i < 3; i++) recorder.record(click(1n));
    await recorder.flush();
    expect(insertBatch.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it('splits a large backlog into batches of maxBatchSize', async () => {
    const { recorder, insertBatch } = setup({ maxBatchSize: 2, maxBufferSize: 100 });
    // Called directly so the early flush doesn't run first.
    for (let i = 0; i < 5; i++) recorder['buffer'].push(click(1n));

    await recorder.flush();

    expect(insertBatch.mock.calls.map(([batch]) => batch.length)).toEqual([2, 2, 1]);
  });

  it('caps memory: drops clicks once the buffer is full', async () => {
    const { recorder, insertBatch } = setup({ maxBatchSize: 1000, maxBufferSize: 3 });
    for (let i = 0; i < 10; i++) recorder.record(click(1n));

    await recorder.flush();

    expect(insertBatch.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it('never throws when the database write fails, and keeps working afterwards', async () => {
    const insertBatch = jest
      .fn<Promise<void>, [ClickEvent[]]>()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue(undefined);
    const { recorder } = setup({}, insertBatch);

    recorder.record(click(1n));
    await expect(recorder.flush()).resolves.toBeUndefined();

    recorder.record(click(2n));
    await recorder.flush();
    expect(insertBatch).toHaveBeenCalledTimes(2);
  });

  it('runs one flush at a time: concurrent callers share it', async () => {
    let release!: () => void;
    const insertBatch = jest.fn(
      (_batch: ClickEvent[]) => new Promise<void>((resolve) => (release = resolve)),
    );
    const { recorder } = setup({}, insertBatch);
    recorder.record(click(1n));

    const first = recorder.flush();
    const second = recorder.flush();
    expect(second).toBe(first);
    release();
    await first;
    expect(insertBatch).toHaveBeenCalledTimes(1);
  });

  it('flushes what is left when stopped (graceful shutdown)', async () => {
    const { recorder, insertBatch } = setup();
    recorder.start();
    recorder.record(click(1n));

    await recorder.stop();

    expect(insertBatch).toHaveBeenCalledTimes(1);
  });
});
