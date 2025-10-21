# @workspace/instrument

Decorator-like logging utilities for TypeScript/JavaScript to log and optionally replay function parameters and return values using fine-grained instrumentation modes.

## Features

- Function wrapper `logCall(fn, options)`
- Method decorator `@LogMethod()` / alias `@InstrumentMethod`
- Class decorator `@LogAll()` / alias `@InstrumentAll` to instrument all methods
- Function wrapper `logCall()` and inline helpers `logInline`, `logVar`, `logVars`
- Session capture + replay (override logged args/return/vars) via `startInstrumentSession` and `setInstrumentSessionReplay`
- Fine-grained control per parameter and return value using `InstrumentType` enum
- Handles sync, async, and promise-returning functions
- Emits structured `LogUnit` objects with dictionary-based `payload.args` & `payload.vars` for direct name access

## Install

In this monorepo, consumers use it via workspace dependency. Externally:

```
npm install @workspace/instrument
```

## Usage

```ts
import { logCall, LogMethod, LogAll } from '@workspace/instrument';

const add = (a: number, b: number) => a + b;
const loggedAdd = logCall(add, { label: 'add' });
console.log(loggedAdd(1, 2));

@LogAll()
class Service {
  greet(name: string) { return `Hello ${name}`; }
}

const s = new Service();
s.greet('world');
```

## Instrumentation Model

Instrumentation now uses an enum to describe behavior per parameter and the return value:

```ts
export enum InstrumentType {
  None = 'None',              // Do not log and not eligible for replay override
  Trace = 'Trace',            // Log the value but do not allow replay override of execution result
  TraceAndReplay = 'TraceAndReplay', // Log and allow replay to override pre-call args (affects execution) or post-call return
}
```

Decorator usage example:

```ts
class Service {
  @InstrumentMethod({
    label: 'fetchContext',
    params: { question: InstrumentType.TraceAndReplay }, // capture & allow replay overrides for `question`
    return: InstrumentType.Trace                         // log return but do not override actual returned value
  })
  async fetchContext(question: string): Promise<string[]> { /* ... */ }
}
```

Function wrapper example:

```ts
const add = (a: number, b: number) => a + b;
const loggedAdd = logCall(add, {
  label: 'add',
  params: { a: InstrumentType.Trace, b: InstrumentType.Trace },
  return: InstrumentType.Trace,
});
loggedAdd(1,2);
```

Return override via replay occurs only when `return: InstrumentType.TraceAndReplay` AND `replayOverrideReturn: true` is specified.

## LogUnit Structure

When instrumentation captures a call, it constructs a `LogUnit`:

```ts
interface LogUnit {
  tagId: string;            // label for the call (function/class.method)
  timestamp: number;        // start time (ms epoch)
  session?: string;         // optional session correlation id
  project?: string;         // optional project label
  payload: {
    args?: Record<string, any>;                    // argument values keyed by parameter name (or arg{index})
    thisArg?: any;                                 // serialized `this` when includeThis enabled
    vars?: Record<string, { value: any; at: string }>; // inline logged variables via logVar/logVars
    return?: any;                                  // return value if logReturn enabled
    error?: string;                                // stack or message on exception
    end?: number;                                  // end timestamp (ms epoch)
    durationMs?: number;                           // elapsed time
  };
}
```

### Access Patterns

Because `args` & `vars` are dictionaries:

```ts
unit.payload.args?.userId; // direct by name
unit.payload.vars?.context?.value; // variable details
```

### Migration Notes

Previous versions used `logArgs`, `logReturn`, and boolean `return` flags plus array/selector forms (`params: ['a','b'] | 'all' | 'none'`). All of these have been replaced by the `InstrumentType` map:

```ts
// Old
@InstrumentMethod({ params: ['a','b'], return: true })

// New
@InstrumentMethod({ params: { a: InstrumentType.Trace, b: InstrumentType.Trace }, return: InstrumentType.Trace })
```

Any parameter omitted from the `params` map defaults to `InstrumentType.None` (not logged). To enable replay override for a parameter, use `TraceAndReplay`.

The former array shapes for `args` / `vars` in emitted units were removed in favor of dictionaries.

## Return Value Replay vs Logging

Return value logging is controlled by `return: InstrumentType.Trace` or `TraceAndReplay`. Only the `TraceAndReplay` mode combined with `replayOverrideReturn: true` will substitute the actual returned value from the call site with the replay return.

If `replayOverrideReturn: false`, replay return values are still recorded in the emitted `LogUnit.payload.return` (with `replayed: true`) but the original function's actual returned value is preserved.

## Session Replay (Override Logged Values)

You can override the logged argument/variable/return data for a session using previously captured `LogUnit`s without altering actual execution. This lets you "replay" a prior run while still running current code (useful for diffing behavior, privacy redaction scenarios, or deterministic evaluation while exercising real side effects).

### How It Works

1. Start a session: `await startInstrumentSession(project, sessionId)` (async: waits for any auto-replay preload).
2. Call `setInstrumentSessionReplay(units)` providing an array of historical `LogUnit` objects.
3. For each emitted unit during this session, if a replay unit exists for the same `tagId`, the logged `payload.args`, `payload.vars`, and `payload.return` are replaced by values from the replay unit (sequentially if multiple).
4. The actual function/method still executes; its real return value is not changed (only the logged one). A flag `payload.replayed: true` is added.

### Example

```ts
import { startInstrumentSession, setInstrumentSessionReplay, LogMethod } from '@workspace/instrument';

// Previously captured units
const previous: LogUnit[] = [
  { tagId: 'Service.compute', timestamp: 0, payload: { args: { a: 1, b: 2 }, return: 3 } },
  { tagId: 'Service.compute', timestamp: 0, payload: { args: { a: 10, b: 20 }, return: 30 } },
];

startInstrumentSession('proj', 'sess');
setInstrumentSessionReplay(previous);

class Service {
  @LogMethod({ logReturn: true })
  compute(a: number, b: number) { return a + b; }
}

const s = new Service();
s.compute(100, 200); // real return 300; logged args/return show first replay (a:1,b:2, return:3)
s.compute(5, 7);     // real return 12; logged args/return show second replay (a:10,b:20, return:30)
```

### Inspecting Units

Replay-modified units include the flag:

```ts
unit.payload.replayed === true;
```

### Notes

- If more calls occur than replay units, the last replay unit is reused.
- Missing fields in replay unit (`args`, `vars`, or `return`) fall back to original logged value.
- Replay does not affect `thisArg`, timing, errors, or the actual runtime result returned to callers.
- Combine with `mockReturn` if you also wish to alter execution result.

### Auto Replay on Session Start

`await startInstrumentSession(project, sessionId, endpoint, autoReplay=true)` will fetch (awaited) existing data for that project/session (if an `endpoint` is provided) and automatically enable replay with any retrieved units. Disable by passing `autoReplay=false`.

```ts
// Auto replay enabled (default): existing units pulled from datalake (await required)
await startInstrumentSession('proj', 'sess-123', 'http://localhost:3300', true);

// Disable auto replay
await startInstrumentSession('proj', 'sess-123', 'http://localhost:3300', false);

// Clear replay state manually
clearInstrumentSessionReplay();
```

Auto replay only overrides logged payload; it never mutates function execution.

