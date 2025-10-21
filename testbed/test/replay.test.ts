import { LogMethod, startInstrumentSession, endInstrumentSession, setInstrumentSessionReplay, InstrumentType } from '@workspace/instrument';
import type { LogUnit } from '@workspace/common';

class ReplayDemo {
  foo(x: number) { return x + 1; }
  bar(msg: string) { return msg.toUpperCase(); }
}
// Apply decorators manually
for (const [name] of [['foo'], ['bar']]) {
  const desc = Object.getOwnPropertyDescriptor(ReplayDemo.prototype, name)!;
  LogMethod({ return: InstrumentType.TraceAndReplay, params: { x: InstrumentType.TraceAndReplay, msg: InstrumentType.TraceAndReplay }, replayOverrideReturn: false })(ReplayDemo.prototype, name, desc);
  Object.defineProperty(ReplayDemo.prototype, name, desc);
}

describe('session replay override', () => {
  test('replays args (affecting execution) while logging replayed return without forcing override of actual return flag', async () => {
    const replayUnits: LogUnit[] = [
      { tagId: 'ReplayDemo.foo', timestamp: Date.now(), payload: { args: { x: 100 }, return: 101 } },
      { tagId: 'ReplayDemo.foo', timestamp: Date.now(), payload: { args: { x: 200 }, return: 201 } },
      { tagId: 'ReplayDemo.bar', timestamp: Date.now(), payload: { args: { msg: 'hi' }, return: 'HI' } },
    ];
  const units = await startInstrumentSession('proj', 'sess');
    setInstrumentSessionReplay(replayUnits);
    const d = new ReplayDemo();
    const r1 = d.foo(1);
    const r2 = d.foo(2);
    const r3 = d.bar('ignore');
  // Actual returns reflect overridden arguments (since args are applied pre-call)
  expect(r1).toBe(101); // x became 100 -> 100+1
  expect(r2).toBe(201); // x became 200 -> 200+1
  expect(r3).toBe('HI'); // msg became 'hi' -> toUpperCase()
    // Logged units show replayed return values
    const fooUnits = units.filter(u => u.tagId === 'ReplayDemo.foo');
    expect(fooUnits[0].payload.return).toBe(101);
    expect(fooUnits[0].payload.replayed).toBe(true);
    expect(fooUnits[1].payload.return).toBe(201);
    expect(fooUnits[1].payload.replayed).toBe(true);
    const barUnit = units.find(u => u.tagId === 'ReplayDemo.bar')!;
    expect(barUnit.payload.return).toBe('HI');
    expect(barUnit.payload.replayed).toBe(true);
    endInstrumentSession();
  });
});
