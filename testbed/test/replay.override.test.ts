import { startInstrumentSession, endInstrumentSession, LogMethod, setInstrumentSessionReplay, InstrumentType } from '@workspace/instrument';
import type { LogUnit } from '@workspace/common';

class DemoService {
  fetchContext(a: string, b: number) {
    return `${a}:${b}`;
  }
  compute(x: number) {
    return x * 2;
  }
}
// Apply decorators manually (and enable return logging) since test tsconfig may not apply experimental decorators automatically
const fetchDesc = Object.getOwnPropertyDescriptor(DemoService.prototype, 'fetchContext')!;
LogMethod({ return: InstrumentType.TraceAndReplay, params: { a: InstrumentType.TraceAndReplay, b: InstrumentType.TraceAndReplay }, replayOverrideReturn: true })(DemoService.prototype, 'fetchContext', fetchDesc);
Object.defineProperty(DemoService.prototype, 'fetchContext', fetchDesc);
const computeDesc = Object.getOwnPropertyDescriptor(DemoService.prototype, 'compute')!;
LogMethod({ return: InstrumentType.TraceAndReplay, params: { x: InstrumentType.TraceAndReplay }, replayOverrideReturn: true })(DemoService.prototype, 'compute', computeDesc);
Object.defineProperty(DemoService.prototype, 'compute', computeDesc);

describe('instrument replay overrides', () => {
  afterEach(() => {
    endInstrumentSession();
  });

  it('overrides return and args via exact tagId', async () => {
    const units = await startInstrumentSession('proj', 'sess');
    // tagIds will be DemoService.fetchContext and DemoService.compute
    const replayUnits: LogUnit[] = [
      {
        tagId: 'DemoService.fetchContext',
        timestamp: Date.now() - 1000,
        session: 'sess',
        project: 'proj',
        payload: { args: { a: 'replayedA', b: 999 }, return: 'REPLAYED', vars: { v1: { value: 42, at: 'v1@loc' } } }
      }
    ];
    setInstrumentSessionReplay(replayUnits);
    const svc = new DemoService();
    const result = svc.fetchContext('origA', 1);
    // Most recent unit should have replayed flag and overridden values; function return overridden
    const last = units[units.length - 1];
    expect(result).toBe('REPLAYED');
    expect(last.payload.return).toBe('REPLAYED');
    expect(last.payload.args?.a).toBe('replayedA');
    expect(last.payload.args?.b).toBe(999);
    expect(last.payload.vars?.v1?.value).toBe(42);
    expect(last.payload.replayed).toBe(true);
  });

  it('overrides using alias when replay tagId lacks class prefix', async () => {
    const units = await startInstrumentSession('proj', 'sess2');
    // Provide replay unit with only method name to test alias fallback
    const replayUnits: LogUnit[] = [
      {
        tagId: 'compute',
        timestamp: Date.now() - 1000,
        session: 'sess2',
        project: 'proj',
        payload: { args: { x: 123 }, return: 555 }
      }
    ];
    setInstrumentSessionReplay(replayUnits);
    const svc = new DemoService();
    const out = svc.compute(7);
    const last = units[units.length - 1];
    expect(out).toBe(555);
    expect(last.payload.return).toBe(555);
    expect(last.payload.args?.x).toBe(123);
    expect(last.payload.replayed).toBe(true);
  });
});
