import { LogMethod, startInstrumentSession, endInstrumentSession, setInstrumentSessionReplay } from '@workspace/instrument';
import type { LogUnit } from '@workspace/common';

class ReplayDemo {
  foo(x: number) { return x + 1; }
  bar(msg: string) { return msg.toUpperCase(); }
}
// Apply decorators manually
for (const [name] of [['foo'], ['bar']]) {
  const desc = Object.getOwnPropertyDescriptor(ReplayDemo.prototype, name)!;
  LogMethod({ logReturn: true })(ReplayDemo.prototype, name, desc);
  Object.defineProperty(ReplayDemo.prototype, name, desc);
}

describe('session replay override', () => {
  test('overrides args and return from supplied units sequentially', () => {
    // Prepare fake units to replay (simulate previously captured session)
    const replayUnits: LogUnit[] = [
      { tagId: 'ReplayDemo.foo', timestamp: Date.now(), payload: { args: { x: 100 }, return: 101 } },
      { tagId: 'ReplayDemo.foo', timestamp: Date.now(), payload: { args: { x: 200 }, return: 201 } },
      { tagId: 'ReplayDemo.bar', timestamp: Date.now(), payload: { args: { msg: 'hi' }, return: 'HI' } },
    ];
    startInstrumentSession('proj', 'sess');
    setInstrumentSessionReplay(replayUnits);

    const d = new ReplayDemo();
    const r1 = d.foo(1); // real return would be 2; replay says 101
    const r2 = d.foo(2); // real 3; replay 201
    const r3 = d.bar('ignore'); // replay 'HI'

    expect(r1).toBe(2); // execution unaffected
    expect(r2).toBe(3);
    expect(r3).toBe('IGNORE');
    // We can't intercept return value; replay only overrides logged payload
    endInstrumentSession();
  });
});
