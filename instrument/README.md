# @workspace/instrument

Decorator-like logging utilities for TypeScript/JavaScript to log function parameters and return values.

## Features

- Function wrapper `logCall(fn, options)`
- Method decorator `@LogMethod()`
- Class decorator `@LogAll()` to instrument all methods
- Handles sync and async functions

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