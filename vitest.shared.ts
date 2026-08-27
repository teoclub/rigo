import ts from 'typescript'

/**
 * Transform standard (TC39) TypeScript decorators before Vite's default
 * parser sees source files. Vite 8's oxc transformer rejects standard
 * decorator syntax with an unlocated "Invalid or unexpected token", so any
 * file using `@Decorator` forms must be pre-transpiled by TypeScript itself
 * (the same pre-transform upstream runs in its vitest configs).
 */
const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

export function standardDecoratorPlugin() {
  return {
    name: 'rigo-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText
          .replace(
            /^(\s*)(__esDecorate\()/gmu,
            '$1/* v8 ignore next -- compiler-synthetic decorator accessors have no source behavior */ $2',
          )
          .replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}
