import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkArchitecture } from '../scripts/check-architecture.js';

function inspect(files: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'monitor-architecture-'));
  try {
    for (const [file, source] of Object.entries(files)) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    return checkArchitecture(root).violations;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('architecture accepts shared contracts, pure product vocabulary and lazy feature imports', () => {
  assert.deepEqual(
    inspect({
      'src/types.ts': 'export type Session = { id: string };',
      'src/shared/git-commit-shortcuts.ts': 'export const prompt = "commit";',
      'server/control.ts':
        'import type { Session } from "../src/types.js"; import { prompt } from "../src/shared/git-commit-shortcuts.js";',
      'src/app/App.tsx': 'export const view = () => import("../features/view.js");',
      'src/features/view.ts': 'export type Session = import("../types.js").Session;',
    }),
    [],
  );
});

test('architecture resolves .js imports and detects cycles through type imports and re-exports', () => {
  const errors = inspect({
    'server/store.ts': 'export type { Query } from "./query.js";',
    'server/query.ts': 'export type Query = import("./store.js").Query;',
  });
  assert.deepEqual(errors, ['dependency cycle: server/query.ts, server/store.ts']);
});

test('architecture detects runtime cycles through dynamic imports and require', () => {
  const errors = inspect({
    'server/first.ts': 'export const load = () => import("./second.js");',
    'server/second.ts': 'const first = require("./first.js");',
  });
  assert.deepEqual(errors, ['dependency cycle: server/first.ts, server/second.ts']);
});

test('architecture rejects server UI coupling even through erased types', () => {
  assert.match(
    inspect({
      'server/service.ts': 'import type { View } from "../src/features/view.js";',
      'src/features/view.ts': 'export type View = string;',
    }).join('\n'),
    /server may only depend on shared contracts/,
  );
});

test('architecture rejects browser server imports and shared feature re-exports', () => {
  const errors = inspect({
    'src/features/view.ts': 'import "../../server/service.js";',
    'src/shared/index.ts': 'export * from "../features/view.js";',
    'server/service.ts': 'export const value = 1;',
  });
  assert.ok(errors.some((error) => error.includes('browser source cannot depend on server')));
  assert.ok(errors.some((error) => error.includes('shared code cannot depend on features')));
});

test('architecture rejects framework and storage dependencies hidden behind pure-model helpers', () => {
  const errors = inspect({
    'src/features/session/session-model.ts': 'import { read } from "./helper.js"; export { read };',
    'src/features/session/helper.ts':
      'import React from "react"; export const read = () => globalThis.localStorage.getItem("key");',
  });
  assert.ok(errors.some((error) => error.includes('platform global localStorage')));
  assert.ok(errors.some((error) => error.includes('cannot depend on external module react')));
});

test('architecture protects shared contracts and the Lark vocabulary from platform dependencies', () => {
  const errors = inspect({
    'src/control-types.ts': 'export const data = fetch("/api");',
    'src/shared/git-commit-shortcuts.ts': 'import fs from "node:fs";',
  });
  assert.ok(errors.some((error) => error.includes('platform global fetch')));
  assert.ok(errors.some((error) => error.includes('cannot depend on external module node:fs')));
});

test('architecture rejects captured global capabilities and computed global access in pure models', () => {
  const errors = inspect({
    'src/types.ts':
      'const storage = localStorage; const send = fetch; use(fetch); const { fetch: request } = globalThis; export const read = globalThis["fetch"];',
  });
  assert.ok(errors.some((error) => error.includes('platform global localStorage')));
  assert.ok(errors.some((error) => error.includes('platform global fetch')));
  assert.ok(errors.some((error) => error.includes('platform global globalThis')));
});

test('architecture allows ordinary property names in pure data and rejects stylesheet effects', () => {
  assert.deepEqual(
    inspect({
      'src/types.ts':
        'const options = { fetch: 1, localStorage: "value" }; export const value = options.fetch;',
    }),
    [],
  );
  assert.match(
    inspect({
      'src/features/session/session-model.ts': 'import "./styles.css";',
    }).join('\n'),
    /pure model cannot depend on external module \.\/styles\.css/,
  );
});

test('architecture ignores dependency-looking comments, strings and non-code assets', () => {
  assert.deepEqual(
    inspect({
      'src/types.ts':
        '// fetch("/api"); import "./missing.js";\nexport const example = "localStorage";',
      'src/app/App.tsx': 'import "../styles.css";',
    }),
    [],
  );
});

test('architecture fails closed for missing local imports and computed module paths', () => {
  const errors = inspect({
    'server/service.ts': 'import "./missing.js"; const load = (file: string) => import(file);',
  });
  assert.ok(errors.some((error) => error.includes('unresolved local dependency ./missing.js')));
  assert.ok(errors.some((error) => error.includes('module paths must be string literals')));
});
