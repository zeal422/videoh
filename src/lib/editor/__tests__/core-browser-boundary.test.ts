import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as ts from 'typescript'

/**
 * Core browser boundary: the pure state core must stay free of browser-only
 * globals. The scanner below parses each top-level core module with the
 * TypeScript compiler API and resolves lexical bindings, so a local variable or
 * parameter named `window` is not a finding.
 *
 * This is a boundary check, not a sandbox. Aliases (`const g = globalThis`),
 * imports, data flow, destructuring from a global object, and dynamic keys can
 * pass. Direct references are the contract.
 */

const ROOT = resolve(__dirname, '..', '..', '..', '..')
const CORE_DIR = join(ROOT, 'src/lib/editor')

/** The four top-level core modules that are explicitly allowed to touch the DOM. */
const DOM_BOUND_FILES = [
  'persistence.ts',
  'project-io.ts',
  'template-store.ts',
  'workspace-store.ts',
] as const

/** Every other top-level core module. Update this list when a module is added or removed. */
const EXPECTED_CORE_FILES: ReadonlyArray<string> = [
  'action-executor.ts',
  'actions.ts',
  'bezier.ts',
  'brand-kit.ts',
  'bundle-zip.ts',
  'chroma-key.ts',
  'clip-gesture.ts',
  'clip-invariants.ts',
  'clipboard.ts',
  'color.ts',
  'commands.ts',
  'constants.ts',
  'ducking.ts',
  'ease-segment.ts',
  'effects.ts',
  'factories.ts',
  'filmstrip.ts',
  'fonts.ts',
  'frame-blend.ts',
  'freeze-plan.ts',
  'keyframe-graph-gesture.ts',
  'keyframes.ts',
  'links.ts',
  'lut.ts',
  'markers.ts',
  'marquee.ts',
  'media-cleanup-plan.ts',
  'menus.ts',
  'offline.ts',
  'pen.ts',
  'placement.ts',
  'project-bundle.ts',
  'project-validation.ts',
  'proxy.ts',
  'ripple-trim.ts',
  'sequence-ops.ts',
  'serialization.ts',
  'shapes.ts',
  'slip.ts',
  'snap.ts',
  'srt.ts',
  'store.ts',
  'templates.ts',
  'text-animations.ts',
  'theme.ts',
  'time.ts',
  'timeline-drop.ts',
  'timeline-edit-plan.ts',
  'timeline-scroll.ts',
  'track-groups.ts',
  'tracks.ts',
  'transform.ts',
  'transition.ts',
  'trim.ts',
  'types.ts',
  'ui-contracts.ts',
  'volume-automation.ts',
  'vtt.ts',
  'workspace.ts',
]

const BANNED_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'caches',
  'indexedDB',
  'URL.createObjectURL',
  'AudioContext',
  'HTMLCanvasElement',
  'FileReader',
  'matchMedia',
  'requestAnimationFrame',
  'MutationObserver',
  'HTMLElement',
  'Image',
  'Worker',
] as const

const PATH_ROOTS = ['URL', 'globalThis', 'self', 'global', 'window'] as const

const BANNED = new Set<string>(BANNED_GLOBALS)
const PATH_ROOT_SET = new Set<string>(PATH_ROOTS)
const TRACKED = new Set<string>([...BANNED_GLOBALS, ...PATH_ROOTS])
const BANNED_PATH_SEGMENTS: ReadonlyArray<{
  token: string
  segments: ReadonlyArray<string>
}> = BANNED_GLOBALS.map((token) => ({ token, segments: token.split('.') }))

/**
 * One source per banned token. This table is intentionally independent of
 * `BANNED_GLOBALS`: removing a token from the scanner rule must fail the
 * matching fixture instead of shrinking the test.
 */
const TOKEN_FIXTURES: ReadonlyArray<{ token: string; source: string }> = [
  { token: 'window', source: 'const value = window' },
  { token: 'document', source: 'const value = document' },
  { token: 'navigator', source: 'const value = navigator' },
  { token: 'localStorage', source: 'const value = localStorage' },
  { token: 'sessionStorage', source: 'const value = sessionStorage' },
  { token: 'caches', source: 'const value = caches' },
  { token: 'indexedDB', source: 'const value = indexedDB' },
  { token: 'URL.createObjectURL', source: 'const value = URL.createObjectURL' },
  { token: 'AudioContext', source: 'const value = AudioContext' },
  { token: 'HTMLCanvasElement', source: 'const value = HTMLCanvasElement' },
  { token: 'FileReader', source: 'const value = FileReader' },
  { token: 'matchMedia', source: 'const value = matchMedia' },
  { token: 'requestAnimationFrame', source: 'const value = requestAnimationFrame' },
  { token: 'MutationObserver', source: 'const value = MutationObserver' },
  { token: 'HTMLElement', source: 'const value = HTMLElement' },
  { token: 'Image', source: 'const value = Image' },
  { token: 'Worker', source: 'const value = Worker' },
]

type ScopeFixture = {
  name: string
  source: string
  expected: number
  tokens?: ReadonlyArray<string>
  lines?: ReadonlyArray<number>
}

/** Scope, path, and AST fixtures. */
const SCOPE_FIXTURES: ReadonlyArray<ScopeFixture> = [
  {
    name: 'computed global access',
    source: "globalThis['document']",
    expected: 1,
    tokens: ['document'],
  },
  {
    name: 'property global access',
    source:
      'globalThis.document\n' +
      'globalThis.self.document\n' +
      "globalThis['self']['document']\n" +
      'globalThis.globalThis.document.title',
    expected: 4,
    tokens: ['document', 'document', 'document', 'document'],
  },
  {
    name: 'URL bracket access',
    source:
      "URL['createObjectURL'](blob)\n" +
      "globalThis['URL.createObjectURL']\n" +
      "globalThis['URL']['createObjectURL']",
    expected: 2,
    tokens: ['URL.createObjectURL', 'URL.createObjectURL'],
  },
  {
    name: 'qualified URL access',
    source: 'globalThis.URL.createObjectURL(blob)\n' + 'globalThis.self.URL.createObjectURL(blob)',
    expected: 2,
    tokens: ['URL.createObjectURL', 'URL.createObjectURL'],
  },
  { name: 'unrelated property', source: 'obj.document', expected: 0 },
  { name: 'comments and strings', source: "// document\nconst text = 'document'", expected: 0 },
  { name: 'shorthand property global', source: 'const value = { window }', expected: 1 },
  {
    name: 'local parameter shadow',
    source: 'function f(window: { start: number }) { return window.start }',
    expected: 0,
  },
  {
    name: 'local const shadow',
    source: 'function f() { const window = { start: 0 }; return window.start }',
    expected: 0,
  },
  {
    name: 'sibling mixed scope',
    source:
      'function a(window: { start: number }) { return window.start }\n' +
      'function b() { return window.innerWidth }',
    expected: 1,
  },
  {
    name: 'block scope',
    source: '{ let window = { start: 0 }; window.start }\nwindow.innerWidth',
    expected: 1,
  },
  {
    name: 'var hoisting',
    source: 'function f() { window.start; var window = { start: 0 }; return window.start }',
    expected: 0,
  },
  {
    name: 'destructuring binding',
    source:
      'function f(obj: { window: { start: number } }) { const { window } = obj; return window.start }',
    expected: 0,
  },
  { name: 'type-only reference', source: 'type W = typeof window', expected: 0 },
  {
    name: 'local path-root shadows',
    source:
      'function f(URL: any, globalThis: any, self: any, global: any) {\n' +
      '  URL.createObjectURL(blob)\n' +
      '  globalThis.document\n' +
      '  globalThis.self.document\n' +
      '  globalThis.globalThis.document.title\n' +
      '  globalThis.self.URL.createObjectURL(blob)\n' +
      '  self.document\n' +
      '  global.document\n' +
      '}',
    expected: 0,
  },
  {
    name: 'method name is not a binding',
    source: 'const obj = { window() { return window.innerWidth } }',
    expected: 1,
  },
  {
    name: 'module-scoped var in a block',
    source: '{ var window = { start: 0 } }\nwindow.start',
    expected: 0,
  },
  {
    name: 'class static block var scope',
    source:
      'class C {\n' +
      '  static {\n' +
      '    var window = { start: 0 }\n' +
      '    window.start\n' +
      '  }\n' +
      '}\n' +
      'window.innerWidth',
    expected: 1,
  },
  {
    name: 'transparent wrappers',
    source:
      '(globalThis as any).document;\n' +
      'globalThis!.document;\n' +
      '(<any>globalThis).document;\n' +
      '(globalThis satisfies any).document;\n' +
      '(URL as any).createObjectURL;\n' +
      'URL!.createObjectURL;\n' +
      '(self as any).document;\n' +
      '(global as any).document;',
    expected: 8,
    tokens: [
      'document',
      'document',
      'document',
      'document',
      'URL.createObjectURL',
      'URL.createObjectURL',
      'document',
      'document',
    ],
  },
  {
    name: 'no-substitution template keys',
    source: 'globalThis[`document`]\nURL[`createObjectURL`](blob)',
    expected: 2,
    tokens: ['document', 'URL.createObjectURL'],
  },
  { name: 'enum binding', source: 'enum window { A }\nwindow.A', expected: 0 },
  {
    name: 'namespace binding',
    source:
      'export {}\n' +
      'namespace window { export const A = 1 }\n' +
      'window.A\n' +
      'namespace document { export type T = number }\n' +
      'document.title\n' +
      'namespace merged { export const document = 1 }\n' +
      'namespace merged { export const A = document }\n' +
      'namespace later { export const A = document }\n' +
      'namespace later { export const document = 1 }\n' +
      'namespace privateNs { const document = 1 }\n' +
      'namespace privateNs { export const B = document.title }\n' +
      'namespace privateSame { const document = 1; export const C = document }\n' +
      'namespace sharedInner { export namespace Inner { export const document = 1 } }\n' +
      'namespace sharedInner { export namespace Inner { export const A = document.title } }\n' +
      'namespace sameBody {\n' +
      '  namespace Inner { export const document = 1 }\n' +
      '  namespace Inner { export const A = document.title }\n' +
      '}\n' +
      'namespace separateInner { namespace Inner { export const document = 1 } }\n' +
      'namespace separateInner { namespace Inner { export const A = document.title } }',
    expected: 3,
    tokens: ['document', 'document', 'document'],
    lines: [5, 11, 20],
  },
  {
    name: 'named class expression binding',
    source: 'const C = class window { static read() { return window.name } }\nwindow.innerWidth',
    expected: 1,
  },
  {
    name: 'namespace body var scope',
    source:
      'namespace N {\n' +
      '  var window = { start: 0 }\n' +
      '  window.start\n' +
      '}\n' +
      'window.innerWidth',
    expected: 1,
  },
  {
    name: 'computed property key',
    source:
      'const obj = { [document]: 1, [navigator]() { return 1 } }\n' +
      'class C { [window]() {} }\n' +
      'abstract class A { abstract [document](): void; abstract [window]: number }\n' +
      'interface I { [window]: number; [document](): void }\n' +
      'function localAccessor(window: string) {\n' +
      '  return { get [window]() { return 1 }, set [window](value: string) {} }\n' +
      '}\n' +
      'const accessors = {\n' +
      '  get [sessionStorage]() { return 1 },\n' +
      '  set [localStorage](value: string) {},\n' +
      '}',
    expected: 5,
    tokens: ['document', 'navigator', 'window', 'sessionStorage', 'localStorage'],
  },
  {
    name: 'ambient declaration',
    source: 'declare const window: { innerWidth: number }\nwindow.innerWidth',
    expected: 1,
  },
  {
    name: 'parameter initializer before body var',
    source:
      'function f(size = window.innerWidth) {\n' +
      '  var window = { innerWidth: 0 }\n' +
      '  return window.innerWidth + size\n' +
      '}',
    expected: 1,
  },
  {
    name: 'class heritage expression',
    source:
      'class A extends window.Base {}\n' +
      'class B extends mixin(window) {}\n' +
      'class C extends Base<window.Type> {}\n' +
      'class D implements window.IFace {}\n' +
      'interface I extends window.Base {}',
    expected: 2,
  },
  {
    name: 'value-position generic instantiation',
    source:
      'const x = window.Base<string>\n' +
      'foo(window.Base<string>)\n' +
      'new window.Base<string>()\n' +
      'make<window.Type>()\n' +
      'new Foo<window.Type>()\n' +
      'const y = globalThis.SomeGeneric<T>\n' +
      'foo(globalThis.SomeGeneric<T>)',
    expected: 3,
  },
  {
    name: 'static block nested function var scope',
    source:
      'class C {\n' +
      '  static {\n' +
      '    function inner() { var window = { start: 0 } }\n' +
      '    window.innerWidth\n' +
      '  }\n' +
      '}',
    expected: 1,
  },
  {
    name: 'enum member names',
    source:
      'enum E { window = 1, document }\n' +
      'enum F { A = window.innerWidth }\n' +
      'enum G { window = 1, A = window }\n' +
      "enum H { 'window' = 1, A = window }\n" +
      "enum I { ['window'] = 1, A = window }\n" +
      'enum J { [`document`] = 1, A = document }\n' +
      'enum M { window = 1 }\n' +
      'enum M { A = window }\n' +
      '{ enum P { window = 1 } }\n' +
      '{ enum P { A = window } }\n' +
      'namespace mergedEnum { export enum E { window = 1 } }\n' +
      'namespace mergedEnum { export enum E { A = window } }',
    expected: 2,
    tokens: ['window', 'window'],
    lines: [2, 10],
  },
  {
    name: 'decorator expressions',
    source:
      '@window.outer\n' +
      'class C {}\n' +
      'class D {\n' +
      '  @document.method\n' +
      '  method() {}\n' +
      '}\n' +
      'function f(window: unknown) {\n' +
      '  @window.local\n' +
      '  class E {}\n' +
      '}',
    expected: 2,
  },
]

type Finding = { file: string; token: string; line: number }
type StaticPath = { root: string; segments: string[] }

function collectPatternNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text)
    return
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectPatternNames(element.name, out)
  }
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/** Root plus the static property segments of a property or element access chain. */
function staticPath(node: ts.Expression): StaticPath | null {
  const segments: string[] = []
  let current = unwrap(node)
  for (;;) {
    if (ts.isIdentifier(current)) return { root: current.text, segments: segments.reverse() }
    if (ts.isPropertyAccessExpression(current)) {
      if (!ts.isIdentifier(current.name)) return null
      segments.push(current.name.text)
      current = unwrap(current.expression)
      continue
    }
    if (ts.isElementAccessExpression(current)) {
      const key = unwrap(current.argumentExpression)
      if (!ts.isStringLiteralLike(key)) return null
      segments.push(key.text)
      current = unwrap(current.expression)
      continue
    }
    return null
  }
}

function scan(file: string, source: string): Finding[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  if (sourceFile.isDeclarationFile) return []

  const scopes: Array<Set<string>> = []
  const findings = new Map<string, Finding>()
  const namespaceExports = new Map<ts.Node, Map<string, Set<string>>>()
  const enumMemberScopes = new Map<string, Set<string>>()
  const nodeIds = new Map<ts.Node, number>()

  const isBound = (name: string): boolean => scopes.some((scope) => scope.has(name))

  function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    if (!ts.canHaveModifiers(node)) return false
    return ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false
  }

  function hasDeclare(node: ts.Node): boolean {
    return hasModifier(node, ts.SyntaxKind.DeclareKeyword)
  }

  function addFinding(node: ts.Node, token: string): void {
    const start = node.getStart(sourceFile)
    const key = `${file}:${start}`
    const existing = findings.get(key)
    if (existing && existing.token.length >= token.length) return
    findings.set(key, {
      file,
      token,
      line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
    })
  }

  function segmentsMatch(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
    return left.length === right.length && left.every((segment, index) => segment === right[index])
  }

  /** A banned path token when the root is global, or null. */
  function bannedPathToken(root: string, segments: string[]): string | null {
    if (!TRACKED.has(root) || !PATH_ROOT_SET.has(root) || isBound(root)) return null
    if (BANNED.has(root)) return root
    let full = root === 'URL' ? ['URL', ...segments] : segments
    // `globalThis.self` and `globalThis.globalThis` are the same global.
    while (root !== 'URL' && (full[0] === 'self' || full[0] === 'globalThis')) {
      full = full.slice(1)
    }
    for (let index = 0; index < full.length; index++) {
      const prefix = full.slice(0, index + 1)
      const match = BANNED_PATH_SEGMENTS.find((entry) => segmentsMatch(entry.segments, prefix))
      if (match) return match.token
    }
    return null
  }

  function isSkippedIdentifier(node: ts.Identifier): boolean {
    const parent = node.parent
    if (!parent) return false
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
    if (ts.isPropertyAssignment(parent) && parent.name === node) return true
    if (ts.isMethodDeclaration(parent) && parent.name === node) return true
    if (ts.isPropertyDeclaration(parent) && parent.name === node) return true
    if (ts.isGetAccessorDeclaration(parent) && parent.name === node) return true
    if (ts.isSetAccessorDeclaration(parent) && parent.name === node) return true
    if (ts.isEnumMember(parent) && parent.name === node) return true
    if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node))
      return true
    if (ts.isParameter(parent) && parent.name === node) return true
    if (ts.isVariableDeclaration(parent) && parent.name === node) return true
    if (ts.isFunctionDeclaration(parent) && parent.name === node) return true
    if (ts.isFunctionExpression(parent) && parent.name === node) return true
    if (ts.isClassDeclaration(parent) && parent.name === node) return true
    if (ts.isClassExpression(parent) && parent.name === node) return true
    if (ts.isInterfaceDeclaration(parent) && parent.name === node) return true
    if (ts.isTypeAliasDeclaration(parent) && parent.name === node) return true
    if (ts.isEnumDeclaration(parent) && parent.name === node) return true
    if (ts.isModuleDeclaration(parent) && parent.name === node) return true
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent))
      return true
    if (ts.isImportEqualsDeclaration(parent) && parent.name === node) return true
    if (ts.isExportSpecifier(parent)) return true
    if (ts.isLabeledStatement(parent) && parent.label === node) return true
    if (ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) {
      if (parent.label === node) return true
    }
    return false
  }

  /**
   * A namespace is a runtime binding only when its body emits a value.
   * TypeScript erases namespaces that contain only interfaces or type aliases,
   * including nested type-only namespaces.
   */
  function moduleIsRuntime(node: ts.ModuleDeclaration): boolean {
    if (!node.body) return false
    return nodeHasRuntimeValue(node.body)
  }

  function nodeHasRuntimeValue(node: ts.Node): boolean {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return false
    if (ts.isModuleDeclaration(node)) return moduleIsRuntime(node)
    if (ts.isModuleBlock(node)) return node.statements.some(nodeHasRuntimeValue)
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      return hasModifier(node, ts.SyntaxKind.ExportKeyword)
    }
    return true
  }

  function collectBlockStatement(node: ts.Statement, out: Set<string>): void {
    if (hasDeclare(node)) return
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        collectPatternNames(declaration.name, out)
      }
      return
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      if (node.name) out.add(node.name.text)
      return
    }
    if (ts.isModuleDeclaration(node)) {
      if (ts.isIdentifier(node.name) && moduleIsRuntime(node)) out.add(node.name.text)
      return
    }
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (!clause || clause.isTypeOnly) return
      if (clause.name) out.add(clause.name.text)
      const bindings = clause.namedBindings
      if (!bindings) return
      if (ts.isNamespaceImport(bindings)) {
        out.add(bindings.name.text)
        return
      }
      for (const specifier of bindings.elements) {
        if (!specifier.isTypeOnly) out.add(specifier.name.text)
      }
      return
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      out.add(node.name.text)
    }
  }

  function collectBlockStatements(statements: ReadonlyArray<ts.Statement>, out: Set<string>): void {
    for (const statement of statements) collectBlockStatement(statement, out)
  }

  /** Collect function-scoped `var` names without crossing a nested scope owner. */
  function collectVarBindings(node: ts.Node, out: Set<string>): void {
    if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isModuleDeclaration(node)) return
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent
      if (
        ts.isVariableDeclarationList(list) &&
        (list.flags & ts.NodeFlags.BlockScoped) === 0 &&
        !hasDeclare(list.parent)
      ) {
        collectPatternNames(node.name, out)
      }
    }
    ts.forEachChild(node, (child) => collectVarBindings(child, out))
  }

  function walkBindingName(name: ts.BindingName): void {
    if (ts.isIdentifier(name)) return
    for (const element of name.elements) {
      if (!ts.isBindingElement(element)) continue
      if (element.propertyName && ts.isComputedPropertyName(element.propertyName)) {
        visit(element.propertyName.expression)
      }
      walkBindingName(element.name)
      if (element.initializer) visit(element.initializer)
    }
  }

  function visitBlock(node: ts.Block | ts.ModuleBlock): void {
    const scope = new Set<string>()
    collectBlockStatements(node.statements, scope)
    scopes.push(scope)
    for (const statement of node.statements) visit(statement)
    scopes.pop()
  }

  function visitFunction(node: ts.SignatureDeclaration): void {
    visitDecorators(node)
    // A computed method or accessor name is evaluated in the enclosing scope,
    // before the method's own parameters exist. Only concrete members run:
    // overload signatures and abstract members are erased.
    const functionName = (node as ts.FunctionLikeDeclaration).name
    const memberBody = (node as ts.FunctionLikeDeclaration).body
    if (
      memberBody &&
      functionName &&
      ts.isComputedPropertyName(functionName) &&
      (ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node))
    ) {
      visit(functionName.expression)
    }
    const scope = new Set<string>()
    scopes.push(scope)
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
      scope.add(node.name.text)
    }
    for (const parameter of node.parameters) {
      if (ts.isIdentifier(parameter.name) && parameter.name.text === 'this') continue
      collectPatternNames(parameter.name, scope)
    }
    // Initializers run before the body, so body `var` bindings must not be in
    // scope yet. They are added after this loop, as hoisted names.
    for (const parameter of node.parameters) {
      if (ts.isIdentifier(parameter.name) && parameter.name.text === 'this') continue
      walkBindingName(parameter.name)
      if (parameter.initializer) visit(parameter.initializer)
    }
    const body = (node as ts.FunctionLikeDeclaration).body
    if (body) {
      if (ts.isBlock(body)) {
        collectVarBindings(body, scope)
        visitBlock(body)
      } else {
        visit(body)
      }
    }
    scopes.pop()
  }

  /**
   * Class, method, accessor, and concrete property decorators are emitted.
   * Parameter and abstract-member decorators are not valid under this repo's
   * emit, so they need no fixture.
   */
  function visitDecorators(node: ts.Node): void {
    if (!ts.canHaveDecorators(node)) return
    for (const decorator of ts.getDecorators(node) ?? []) visit(decorator.expression)
  }

  function visitClass(node: ts.ClassDeclaration | ts.ClassExpression): void {
    visitDecorators(node)
    const scope = new Set<string>()
    scopes.push(scope)
    if (ts.isClassExpression(node) && node.name) scope.add(node.name.text)
    for (const clause of node.heritageClauses ?? []) {
      for (const type of clause.types) visit(type)
    }
    for (const member of node.members) visit(member)
    scopes.pop()
  }

  function visitStaticBlock(node: ts.ClassStaticBlockDeclaration): void {
    const scope = new Set<string>()
    scopes.push(scope)
    collectVarBindings(node.body, scope)
    visitBlock(node.body)
    scopes.pop()
  }

  function namespaceRoot(node: ts.ModuleDeclaration): ts.Node {
    let current: ts.ModuleDeclaration = node
    while (true) {
      const parent: ts.Node = current.parent
      if (ts.isModuleDeclaration(parent)) {
        // `namespace A.B` declares B as an exported member of A.
        current = parent
        continue
      }
      if (ts.isModuleBlock(parent)) {
        const owner = parent.parent
        if (
          ts.isModuleDeclaration(owner) &&
          (hasModifier(current, ts.SyntaxKind.ExportKeyword) || inAmbientContext(parent))
        ) {
          current = owner
          continue
        }
        // A non-exported nested namespace is private to this declaration body.
        return ts.isModuleDeclaration(owner) ? owner : parent
      }
      return parent
    }
  }

  function namespacePath(node: ts.ModuleDeclaration): string {
    const parts: string[] = []
    let current: ts.Node | undefined = node
    while (current) {
      if (ts.isModuleDeclaration(current) && ts.isIdentifier(current.name)) {
        parts.unshift(current.name.text)
        current = current.parent
        continue
      }
      if (ts.isModuleBlock(current)) {
        current = current.parent
        continue
      }
      break
    }
    return parts.join('.')
  }

  function sharedNamespaceBindings(node: ts.ModuleDeclaration): ReadonlySet<string> | undefined {
    return namespaceExports.get(namespaceRoot(node))?.get(namespacePath(node))
  }

  function inAmbientContext(node: ts.Node): boolean {
    let current: ts.Node | undefined = node
    while (current) {
      if (hasDeclare(current)) return true
      current = current.parent
    }
    return false
  }

  function collectExportedValueBindings(
    statements: ReadonlyArray<ts.Statement>,
    out: Set<string>,
    includeAll: boolean,
  ): void {
    for (const statement of statements) {
      if (!includeAll && !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          collectPatternNames(declaration.name, out)
        }
        continue
      }
      if (
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)
      ) {
        if (statement.name) out.add(statement.name.text)
        continue
      }
      if (ts.isModuleDeclaration(statement)) {
        if (
          ts.isIdentifier(statement.name) &&
          (moduleIsRuntime(statement) || hasDeclare(statement))
        ) {
          out.add(statement.name.text)
        }
        continue
      }
      if (ts.isImportEqualsDeclaration(statement)) {
        out.add(statement.name.text)
      }
    }
  }

  function collectNamespaceExports(): void {
    const walk = (node: ts.Node): void => {
      if (
        ts.isModuleDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        !(node.flags & ts.NodeFlags.GlobalAugmentation)
      ) {
        const root = namespaceRoot(node)
        const path = namespacePath(node)
        let byPath = namespaceExports.get(root)
        if (!byPath) {
          byPath = new Map<string, Set<string>>()
          namespaceExports.set(root, byPath)
        }
        let names = byPath.get(path)
        if (!names) {
          names = new Set<string>()
          byPath.set(path, names)
        }
        if (node.body) {
          const ambient = inAmbientContext(node)
          if (ts.isModuleBlock(node.body)) {
            collectExportedValueBindings(node.body.statements, names, ambient)
          } else if (ts.isModuleDeclaration(node.body) && ts.isIdentifier(node.body.name)) {
            if (moduleIsRuntime(node.body) || ambient) names.add(node.body.name.text)
          }
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(sourceFile)
  }

  function nodeId(node: ts.Node): number {
    let id = nodeIds.get(node)
    if (id === undefined) {
      id = nodeIds.size
      nodeIds.set(node, id)
    }
    return id
  }

  function enclosingScopeNode(node: ts.Node): ts.Node {
    let current: ts.Node | undefined = node.parent
    while (current) {
      if (
        ts.isSourceFile(current) ||
        ts.isBlock(current) ||
        ts.isModuleBlock(current) ||
        ts.isCaseBlock(current)
      ) {
        return current
      }
      current = current.parent
    }
    return sourceFile
  }

  function enumScopeKey(node: ts.EnumDeclaration): string {
    const container = enclosingScopeNode(node)
    if (ts.isModuleBlock(container)) {
      const owner = container.parent
      if (
        ts.isModuleDeclaration(owner) &&
        ts.isIdentifier(owner.name) &&
        (hasModifier(node, ts.SyntaxKind.ExportKeyword) || inAmbientContext(container))
      ) {
        return `namespace:${nodeId(namespaceRoot(owner))}:${namespacePath(owner)}`
      }
    }
    return `node:${nodeId(container)}`
  }

  function collectEnumMemberScopes(): void {
    const walk = (node: ts.Node): void => {
      if (ts.isEnumDeclaration(node)) {
        const key = `${enumScopeKey(node)}#${node.name.text}`
        let names = enumMemberScopes.get(key)
        if (!names) {
          names = new Set<string>()
          enumMemberScopes.set(key, names)
        }
        for (const member of node.members) {
          if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
            names.add(member.name.text)
          } else if (
            ts.isComputedPropertyName(member.name) &&
            ts.isStringLiteralLike(member.name.expression)
          ) {
            names.add(member.name.expression.text)
          }
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(sourceFile)
  }

  function visitModule(node: ts.ModuleDeclaration): void {
    if (hasDeclare(node) || !node.body) return
    const shared = sharedNamespaceBindings(node)
    if (ts.isModuleBlock(node.body)) {
      const scope = new Set<string>(shared ?? [])
      scopes.push(scope)
      collectVarBindings(node.body, scope)
      visitBlock(node.body)
      scopes.pop()
      return
    }
    if (ts.isModuleDeclaration(node.body)) {
      const scope = new Set<string>(shared ?? [])
      scopes.push(scope)
      if (ts.isIdentifier(node.body.name) && moduleIsRuntime(node.body)) {
        scope.add(node.body.name.text)
      }
      visitModule(node.body)
      scopes.pop()
      return
    }
    visit(node.body)
  }

  function visitEnum(node: ts.EnumDeclaration): void {
    // Unqualified references in an initializer resolve to the enum's members,
    // including members declared in a merged declaration in the same scope.
    const scope = new Set(enumMemberScopes.get(`${enumScopeKey(node)}#${node.name.text}`) ?? [])
    scopes.push(scope)
    for (const member of node.members) {
      if (member.initializer) visit(member.initializer)
    }
    scopes.pop()
  }

  function visitCaseBlock(node: ts.CaseBlock): void {
    const scope = new Set<string>()
    for (const clause of node.clauses) collectBlockStatements(clause.statements, scope)
    scopes.push(scope)
    for (const clause of node.clauses) {
      if (ts.isCaseClause(clause)) visit(clause.expression)
      for (const statement of clause.statements) visit(statement)
    }
    scopes.pop()
  }

  function visitFor(node: ts.ForStatement | ts.ForInStatement | ts.ForOfStatement): void {
    const scope = new Set<string>()
    scopes.push(scope)
    const initializer = node.initializer
    if (initializer && ts.isVariableDeclarationList(initializer)) {
      for (const declaration of initializer.declarations) {
        collectPatternNames(declaration.name, scope)
      }
      for (const declaration of initializer.declarations) visit(declaration)
    } else if (initializer) {
      visit(initializer)
    }
    if (ts.isForStatement(node)) {
      if (node.condition) visit(node.condition)
      if (node.incrementor) visit(node.incrementor)
    } else {
      visit(node.expression)
    }
    visit(node.statement)
    scopes.pop()
  }

  function visitCatch(node: ts.CatchClause): void {
    const scope = new Set<string>()
    scopes.push(scope)
    if (node.variableDeclaration) {
      collectPatternNames(node.variableDeclaration.name, scope)
      walkBindingName(node.variableDeclaration.name)
    }
    visit(node.block)
    scopes.pop()
  }

  function visit(node: ts.Node): void {
    if (hasDeclare(node)) return

    if (ts.isSourceFile(node)) {
      const scope = new Set<string>()
      collectBlockStatements(node.statements, scope)
      collectVarBindings(node, scope)
      scopes.push(scope)
      for (const statement of node.statements) visit(statement)
      scopes.pop()
      return
    }

    if (ts.isExpressionWithTypeArguments(node)) {
      const parent = node.parent
      if (ts.isHeritageClause(parent)) {
        // `ExpressionWithTypeArguments` is a type node, but its expression can
        // run. Only a class `extends` clause executes it; `implements` and
        // interface heritage are erased.
        if (clauseIsRuntime(parent, node)) visit(node.expression)
        return
      }
      visit(node.expression)
      return
    }
    if (ts.isTypeNode(node)) return
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return
    // An abstract property is erased, so its computed name never runs.
    if (ts.isPropertyDeclaration(node) && hasModifier(node, ts.SyntaxKind.AbstractKeyword)) return

    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return
    if (ts.isExportDeclaration(node)) return

    if (ts.isFunctionLike(node)) {
      visitFunction(node)
      return
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      visitClass(node)
      return
    }
    if (ts.isClassStaticBlockDeclaration(node)) {
      visitStaticBlock(node)
      return
    }
    if (ts.isModuleDeclaration(node)) {
      visitModule(node)
      return
    }
    if (ts.isEnumDeclaration(node)) {
      visitEnum(node)
      return
    }
    if (ts.isBlock(node)) {
      visitBlock(node)
      return
    }
    if (ts.isCaseBlock(node)) {
      visitCaseBlock(node)
      return
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      visitFor(node)
      return
    }
    if (ts.isCatchClause(node)) {
      visitCatch(node)
      return
    }
    if (ts.isVariableDeclaration(node)) {
      walkBindingName(node.name)
      if (node.initializer) visit(node.initializer)
      return
    }
    if (ts.isPropertyAccessExpression(node)) {
      const path = staticPath(node)
      const token = path ? bannedPathToken(path.root, path.segments) : null
      if (token) {
        addFinding(node, token)
        return
      }
      visit(node.expression)
      return
    }
    if (ts.isElementAccessExpression(node)) {
      const path = staticPath(node)
      const token = path ? bannedPathToken(path.root, path.segments) : null
      if (token) {
        addFinding(node, token)
        return
      }
      visit(node.expression)
      visit(node.argumentExpression)
      return
    }
    if (ts.isIdentifier(node)) {
      if (!TRACKED.has(node.text) || isSkippedIdentifier(node)) return
      if (!isBound(node.text) && BANNED.has(node.text)) addFinding(node, node.text)
      return
    }

    ts.forEachChild(node, visit)
  }

  function clauseIsRuntime(
    clause: ts.HeritageClause,
    node: ts.ExpressionWithTypeArguments,
  ): boolean {
    if (!clause.types.includes(node)) return false
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) return false
    return ts.isClassDeclaration(clause.parent) || ts.isClassExpression(clause.parent)
  }

  collectNamespaceExports()
  collectEnumMemberScopes()
  visit(sourceFile)
  return [...findings.values()]
}

function readCore(file: string): string {
  return readFileSync(join(CORE_DIR, file), 'utf8')
}

const DOM_BOUND = new Set<string>(DOM_BOUND_FILES)

describe('core browser boundary', () => {
  it('scans exactly the classified top-level core modules', () => {
    const entries = readdirSync(CORE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
    const tsx = entries.filter((name) => name.endsWith('.tsx')).sort()
    expect(tsx, 'core modules must use .ts so the scan cannot skip a .tsx file').toEqual([])
    const actual = entries
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => !DOM_BOUND.has(name))
      .sort()
    expect(actual).toEqual([...EXPECTED_CORE_FILES])
  })

  it('keeps every browser-bound allowlist entry present and readable', () => {
    for (const file of DOM_BOUND_FILES) {
      const path = join(CORE_DIR, file)
      expect(existsSync(path), file).toBe(true)
      expect(readFileSync(path, 'utf8').length, file).toBeGreaterThan(0)
    }
  })

  it('keeps the pure core free of banned browser globals', () => {
    const findings = EXPECTED_CORE_FILES.flatMap((file) => scan(file, readCore(file)))
    expect(findings.map((finding) => `${finding.file}:${finding.line} ${finding.token}`)).toEqual(
      [],
    )
  }, 15000)

  it.each(TOKEN_FIXTURES)('flags the banned token $token', ({ token, source }) => {
    const findings = scan('token-fixture.ts', source)
    expect(findings.map((finding) => finding.token)).toEqual([token])
  })

  it.each(SCOPE_FIXTURES)('$name', ({ name, source, expected, tokens, lines }) => {
    const findings = scan(name, source)
    expect(findings).toHaveLength(expected)
    if (tokens) {
      expect(findings.map((finding) => finding.token)).toEqual(tokens)
    }
    if (lines) {
      expect(findings.map((finding) => finding.line)).toEqual(lines)
    }
  })
})
