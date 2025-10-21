import { startInstrumentSession, endInstrumentSession, LogMethod, setInstrumentSessionReplay, InstrumentType } from '@workspace/instrument';
import type { LogUnit } from '@workspace/common';

class ArgReplayService {
  combine(a: string, b: string) {
    return `${a}|${b}`;
  }
  compute(x: number) {
    return x * 10;
  }
}
// Manually apply decorators so tests work without experimentalDecorators in test tsconfig
const combineDesc = Object.getOwnPropertyDescriptor(ArgReplayService.prototype,'combine')!;
LogMethod({ label: 'ArgReplayService.combine', params: { a: InstrumentType.TraceAndReplay, b: InstrumentType.TraceAndReplay }, return: InstrumentType.TraceAndReplay, replayOverrideReturn: true })(ArgReplayService.prototype,'combine', combineDesc);
Object.defineProperty(ArgReplayService.prototype,'combine', combineDesc);
const computeDesc = Object.getOwnPropertyDescriptor(ArgReplayService.prototype,'compute')!;
LogMethod({ label: 'ArgReplayService.compute', params: { x: InstrumentType.TraceAndReplay }, return: InstrumentType.TraceAndReplay, replayOverrideReturn: true })(ArgReplayService.prototype,'compute', computeDesc);
Object.defineProperty(ArgReplayService.prototype,'compute', computeDesc);

describe('parameter replay', () => {
  afterEach(() => endInstrumentSession());

  it('overrides arguments before call and return after call', async () => {
    const units = await startInstrumentSession('proj','sessArgs');
    const replayUnits: LogUnit[] = [
      { tagId: 'ArgReplayService.combine', timestamp: Date.now()-500, session:'sessArgs', project:'proj', payload:{ args:{ a:'RA', b:'RB' }, return: 'RA|RB' } },
      { tagId: 'ArgReplayService.compute', timestamp: Date.now()-400, session:'sessArgs', project:'proj', payload:{ args:{ x: 99 }, return: 990 } }
    ];
    setInstrumentSessionReplay(replayUnits);
    const svc = new ArgReplayService();
    const r1 = svc.combine('origA','origB');
    const r2 = svc.compute(2);
    // Last two emitted units should reflect overrides
    const combineUnit = units.find(u => u.tagId === 'ArgReplayService.combine')!;
    const computeUnit = units.find(u => u.tagId === 'ArgReplayService.compute')!;
    expect(r1).toBe('RA|RB');
    expect(combineUnit.payload.args?.a).toBe('RA');
    expect(combineUnit.payload.args?.b).toBe('RB');
    expect(combineUnit.payload.replayed).toBe(true);
    expect(r2).toBe(990);
    expect(computeUnit.payload.args?.x).toBe(99);
    expect(computeUnit.payload.replayed).toBe(true);
  });

  it('overrides only arguments (no return override)', async () => {
    const units = await startInstrumentSession('proj','sessArgsOnly');
    // Replay provides args but omits return so original function return should be used
    const replayUnits: LogUnit[] = [
      { tagId: 'ArgReplayService.combine', timestamp: Date.now()-500, session:'sessArgsOnly', project:'proj', payload:{ args:{ a:'PX', b:'PY' } } },
    ];
    setInstrumentSessionReplay(replayUnits);
    const svc = new ArgReplayService();
    const out = svc.combine('origA','origB');
    const unit = units.find(u => u.tagId === 'ArgReplayService.combine')!;
    // Args should be replaced
    expect(unit.payload.args?.a).toBe('PX');
    expect(unit.payload.args?.b).toBe('PY');
    // Return not overridden -> original uses overridden args inside function so result reflects overridden args
    expect(out).toBe('PX|PY');
    expect(unit.payload.return).toBe('PX|PY');
    expect(unit.payload.replayed).toBe(true);
  });

  it('overrides only return (no argument override)', async () => {
    const units = await startInstrumentSession('proj','sessReturnOnly');
    // Replay provides return but no args; original args should remain
    const replayUnits: LogUnit[] = [
      { tagId: 'ArgReplayService.combine', timestamp: Date.now()-500, session:'sessReturnOnly', project:'proj', payload:{ return:'RR' } },
    ];
    setInstrumentSessionReplay(replayUnits);
    const svc = new ArgReplayService();
    const out = svc.combine('origA','origB');
    const unit = units.find(u => u.tagId === 'ArgReplayService.combine')!;
    // Args logged should show original (since not overridden) but may be absent if params selection limited
    if (unit.payload.args) {
      expect(unit.payload.args?.a).toBe('origA');
      expect(unit.payload.args?.b).toBe('origB');
    }
    // Function return overridden
    expect(out).toBe('RR');
    expect(unit.payload.return).toBe('RR');
    expect(unit.payload.replayed).toBe(true);
  });

  it('overrides arguments when replay uses arg index keys', async () => {
    const units = await startInstrumentSession('proj','sessArgsIndex');
    // Replay supplies args keyed by arg0/arg1 (index form) instead of param names
    const replayUnits: LogUnit[] = [
      { tagId: 'ArgReplayService.combine', timestamp: Date.now()-500, session:'sessArgsIndex', project:'proj', payload:{ args:{ arg0:'IX', arg1:'IY' } } },
    ];
    setInstrumentSessionReplay(replayUnits);
    const svc = new ArgReplayService();
    const out = svc.combine('origA','origB');
    const unit = units.find(u => u.tagId === 'ArgReplayService.combine')!;
    // Output should reflect overridden arguments even though replay used index keys
    expect(out).toBe('IX|IY');
    expect(unit.payload.replayed).toBe(true);
    // Ensure overridden values present in logged args (either under name or index keys)
    const argValues = Object.values(unit.payload.args || {});
    expect(argValues).toContain('IX');
    expect(argValues).toContain('IY');
  });
});
