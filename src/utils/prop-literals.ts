export type PropLiteral = string | number | boolean

/** Parse only literal unions; never resolve aliases or evaluate type expressions. */
function parseLiteralUnion (type: string): PropLiteral[] | undefined {
  const values: PropLiteral[] = []
  let offset = 0
  while (offset < type.length) {
    const rest = type.slice(offset)
    const match = rest.match(/^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|boolean|undefined|null)\s*(\||$)/i)
    if (!match) { return }
    const token = match[1]
    if (token === 'boolean') { values.push(true, false) } else if (token !== 'undefined' && token !== 'null') {
      if (token[0] === "'") {
        // Translate a single-quoted literal to JSON without splitting inside escapes.
        let json = '"'
        for (let i = 1; i < token.length - 1; i++) {
          if (token[i] === '\\') {
            const escaped = token[++i]
            json += escaped === "'" ? "'" : '\\' + escaped
          } else {
            json += token[i] === '"' ? '\\"' : token[i]
          }
        }
        try { values.push(JSON.parse(json + '"')) } catch { return }
      } else {
        try {
          const value = JSON.parse(token)
          if (typeof value === 'number' && !Number.isFinite(value)) { return }
          values.push(value)
        } catch { return }
      }
    }
    offset += match[0].length
    if (match[2] && offset === type.length) { return }
  }
  return values
}

/** vue-component-meta represents unions as enum schemas with literal type-string leaves. */
export function getPropLiteralValues (prop: { type?: string, schema?: unknown }): PropLiteral[] {
  function readSchema (schema: unknown): PropLiteral[] | undefined {
    if (typeof schema === 'string') { return parseLiteralUnion(schema) }
    if (!schema || typeof schema !== 'object') { return }
    const enumSchema = schema as { kind?: string, schema?: unknown[] }
    if (enumSchema.kind !== 'enum' || !Array.isArray(enumSchema.schema)) { return }
    const values: PropLiteral[] = []
    for (const member of enumSchema.schema) {
      const literals = readSchema(member)
      if (!literals) { return }
      values.push(...literals)
    }
    return values
  }
  const values = prop.schema === undefined ? parseLiteralUnion(prop.type ?? '') : readSchema(prop.schema)
  return [...new Set(values ?? [])]
}
