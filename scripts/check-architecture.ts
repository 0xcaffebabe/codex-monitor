import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

type Dependency = { specifier: string; target?: string; line: number };
type Module = { file: string; dependencies: Dependency[]; globals: Set<string> };

const slash = (value: string) => value.replaceAll('\\', '/');
const inside = (file: string, directory: string) => file.startsWith(`${directory}/`);
// This shared product vocabulary is also used by Lark. It must remain platform independent.
const sharedProductModule = 'src/shared/git-commit-shortcuts.ts';
const pureModels = new Set([
  'src/features/session/session-model.ts',
  'src/features/workspace/session-list-model.ts',
]);
const platformGlobals = new Set([
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'fetch',
  'WebSocket',
  'XMLHttpRequest',
  'EventSource',
  'process',
  'Buffer',
  'globalThis',
]);
const contract = (file: string) =>
  /^src\/(?:types|[^/]+-types)\.ts$/.test(file) || file === 'src/workspaces.ts';

/** Check source dependencies, including erased type imports, against the documented boundaries. */
export function checkArchitecture(root = process.cwd()) {
  root = path.resolve(root);
  const configPath = path.join(root, 'tsconfig.json');
  const config = existsSync(configPath)
    ? ts.readConfigFile(configPath, ts.sys.readFile)
    : undefined;
  if (config?.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const converted = ts.convertCompilerOptionsFromJson(
    config?.config.compilerOptions ?? {
      module: 'ESNext',
      moduleResolution: 'Bundler',
    },
    root,
  );
  if (converted.errors.length)
    throw new Error(
      converted.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n'),
    );
  const cache = ts.createModuleResolutionCache(root, slash, converted.options);
  const modules = new Map<string, Module>();
  const violations: string[] = [];
  for (const directory of ['src', 'server']) {
    const absolute = path.join(root, directory);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { recursive: true, encoding: 'utf8' })) {
      const file = `${directory}/${slash(entry)}`;
      if (!/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(file)) continue;
      const source = ts.createSourceFile(
        file,
        readFileSync(path.join(root, file), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const module: Module = { file, dependencies: [], globals: new Set() };
      modules.set(file, module);
      const visit = (node: ts.Node) => {
        let specifier: ts.Node | undefined;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          specifier = node.moduleSpecifier;
        else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
          specifier = node.argument.literal;
        else if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference)
        )
          specifier = node.moduleReference.expression;
        else if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        )
          specifier = node.arguments[0];
        if (specifier) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          if (!ts.isStringLiteralLike(specifier))
            violations.push(`${file}:${line}: module paths must be string literals`);
          else if (/\.(?:css|svg|png|jpg|webp|avif)$/.test(specifier.text)) {
            module.dependencies.push({ specifier: specifier.text, line });
          } else {
            const resolved = ts.resolveModuleName(
              specifier.text,
              path.join(root, file),
              converted.options,
              ts.sys,
              cache,
            ).resolvedModule;
            const target =
              resolved && !resolved.isExternalLibraryImport
                ? slash(path.relative(root, resolved.resolvedFileName))
                : undefined;
            module.dependencies.push({ specifier: specifier.text, target, line });
            if (specifier.text.startsWith('.') && !target)
              violations.push(`${file}:${line}: unresolved local dependency ${specifier.text}`);
          }
        }
        if (ts.isIdentifier(node) && platformGlobals.has(node.text)) {
          const parent = node.parent;
          // Ignore declarations and property names, but include globalThis.fetch and window.fetch.
          if (
            (ts.isPropertyAccessExpression(parent) &&
              (parent.expression === node ||
                (ts.isIdentifier(parent.expression) && parent.expression.text === 'globalThis'))) ||
            (ts.isCallExpression(parent) && parent.expression === node) ||
            (ts.isNewExpression(parent) && parent.expression === node) ||
            (ts.isVariableDeclaration(parent) && parent.initializer === node) ||
            (ts.isElementAccessExpression(parent) && parent.expression === node) ||
            (ts.isCallExpression(parent) &&
              parent.arguments.some((argument) => argument === node)) ||
            ts.isReturnStatement(parent) ||
            ts.isShorthandPropertyAssignment(parent)
          )
            module.globals.add(node.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }

  for (const module of modules.values())
    for (const dependency of module.dependencies) {
      const target = dependency.target;
      if (!target) continue;
      const location = `${module.file}:${dependency.line}`;
      if (inside(module.file, 'src') && inside(target, 'server'))
        violations.push(`${location}: browser source cannot depend on server: ${target}`);
      if (
        inside(module.file, 'server') &&
        inside(target, 'src') &&
        !contract(target) &&
        target !== sharedProductModule
      )
        violations.push(
          `${location}: server may only depend on shared contracts and product vocabulary: ${target}`,
        );
      if (
        inside(module.file, 'src/shared') &&
        (inside(target, 'src/features') || inside(target, 'src/app'))
      )
        violations.push(`${location}: shared code cannot depend on features or app: ${target}`);
    }

  // Check the complete dependency closure so a pure model cannot hide I/O behind a helper.
  const pure = new Set<string>();
  const visitPure = (file: string) => {
    if (pure.has(file)) return;
    pure.add(file);
    const module = modules.get(file);
    if (!module) return;
    for (const global of module.globals)
      violations.push(`${file}: platform global ${global} in a contract or pure model dependency`);
    for (const dependency of module.dependencies) {
      if (dependency.target && modules.has(dependency.target)) visitPure(dependency.target);
      else
        violations.push(
          `${file}:${dependency.line}: contract or pure model cannot depend on external module ${dependency.specifier}`,
        );
    }
  };
  for (const file of modules.keys())
    if (contract(file) || pureModels.has(file) || file === sharedProductModule) visitPure(file);

  // Frontend implementations need a production caller; shared contracts can be server-only.
  if (modules.has('src/main.tsx')) {
    const reachable = new Set<string>();
    const visitReachable = (file: string) => {
      if (reachable.has(file)) return;
      reachable.add(file);
      for (const { target } of modules.get(file)?.dependencies ?? [])
        if (target && modules.has(target)) visitReachable(target);
    };
    visitReachable('src/main.tsx');
    for (const file of modules.keys()) if (contract(file)) visitReachable(file);
    visitReachable(sharedProductModule);
    for (const file of modules.keys())
      if (inside(file, 'src') && !reachable.has(file))
        violations.push(`${file}: frontend module has no production caller`);
  }

  // Tarjan's algorithm reports each strongly connected component once, including type-only cycles.
  let next = 0;
  const indices = new Map<string, number>(),
    low = new Map<string, number>();
  const active = new Set<string>(),
    stack: string[] = [];
  const visitCycle = (file: string) => {
    indices.set(file, next);
    low.set(file, next++);
    stack.push(file);
    active.add(file);
    for (const { target } of modules.get(file)!.dependencies) {
      if (!target || !modules.has(target)) continue;
      if (!indices.has(target)) {
        visitCycle(target);
        low.set(file, Math.min(low.get(file)!, low.get(target)!));
      } else if (active.has(target)) low.set(file, Math.min(low.get(file)!, indices.get(target)!));
    }
    if (low.get(file) !== indices.get(file)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      active.delete(member);
      component.push(member);
    } while (member !== file);
    if (
      component.length > 1 ||
      modules.get(file)!.dependencies.some(({ target }) => target === file)
    )
      violations.push(`dependency cycle: ${component.sort().join(', ')}`);
  };
  for (const file of modules.keys()) if (!indices.has(file)) visitCycle(file);
  return { modules: modules.size, violations: [...new Set(violations)].sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = checkArchitecture();
  if (result.violations.length) {
    console.error(result.violations.join('\n'));
    process.exitCode = 1;
  } else console.log(`Architecture check passed (${result.modules} modules).`);
}
