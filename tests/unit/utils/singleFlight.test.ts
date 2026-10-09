import { SingleFlight } from '../../../src/utils/singleFlight';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe('SingleFlight', () => {
  it('runs the function once for concurrent calls with the same key', async () => {
    const flight = new SingleFlight<string, number>();
    const pending = deferred<number>();
    const fn = jest.fn(() => pending.promise);

    const calls = [flight.run('a', fn), flight.run('a', fn), flight.run('a', fn)];
    pending.resolve(42);

    await expect(Promise.all(calls)).resolves.toEqual([42, 42, 42]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs separately for different keys', async () => {
    const flight = new SingleFlight<string, string>();
    const fn = jest.fn((key: string) => Promise.resolve(key));

    await Promise.all([flight.run('a', () => fn('a')), flight.run('b', () => fn('b'))]);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('runs again once the previous call has finished (no caching of results)', async () => {
    const flight = new SingleFlight<string, number>();
    const fn = jest.fn(() => Promise.resolve(1));

    await flight.run('a', fn);
    await flight.run('a', fn);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('shares a failure with every waiter, then lets the next call retry', async () => {
    const flight = new SingleFlight<string, number>();
    const pending = deferred<number>();

    const calls = [flight.run('a', () => pending.promise), flight.run('a', () => pending.promise)];
    pending.reject(new Error('db down'));

    for (const call of calls) await expect(call).rejects.toThrow('db down');
    await expect(flight.run('a', () => Promise.resolve(7))).resolves.toBe(7);
  });
});
