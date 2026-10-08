/**
 * The whole of the mapping language: literal text with `${field}` references,
 * `${field|default}` where the field may be absent, and nothing else. Not a
 * template engine and not JavaScript — every construct that is not one of
 * those two is refused when the template is compiled, which is at startup,
 * by the name of the variable it came from.
 *
 * Fields are looked up by dotted path in the item's fields. A reference to a
 * field the item does not carry, with no default, is a `MissingField` at run
 * time: the item is skipped and counted, never silently emitted as the string
 * `undefined`, which is the shape the core's own front door shipped once.
 */
export type Fields = Readonly<Record<string, unknown>>

export class TemplateError extends Error {
  override readonly name = 'TemplateError'
}
export class MissingField extends Error {
  override readonly name = 'MissingField'
  constructor(readonly field: string) {
    super(`the item has no field ${JSON.stringify(field)}`)
  }
}

type Part = { readonly text: string } | { readonly ref: string; readonly fallback: string | undefined }

const REF = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/

export interface Template {
  readonly source: string
  /** Every field the template reads, for a startup check against what a source offers. */
  readonly fields: readonly string[]
  render(fields: Fields): string
}

export function compile(source: string, name: string): Template {
  const parts: Part[] = []
  let i = 0
  while (i < source.length) {
    const open = source.indexOf('${', i)
    if (open === -1) {
      parts.push({ text: source.slice(i) })
      break
    }
    if (open > i) parts.push({ text: source.slice(i, open) })
    const close = source.indexOf('}', open)
    if (close === -1) throw new TemplateError(`${name}: unclosed \${ in ${JSON.stringify(source)}`)
    const inner = source.slice(open + 2, close)
    const bar = inner.indexOf('|')
    const ref = (bar === -1 ? inner : inner.slice(0, bar)).trim()
    const fallback = bar === -1 ? undefined : inner.slice(bar + 1)
    if (!REF.test(ref)) {
      throw new TemplateError(
        `${name}: ${JSON.stringify('${' + inner + '}')} is not a field reference. ` +
          'A reference is lower-case letters, digits, underscores and dots, optionally followed by |default.',
      )
    }
    parts.push({ ref, fallback })
    i = close + 1
  }
  const fields = parts.flatMap((p) => ('ref' in p ? [p.ref] : []))
  return {
    source,
    fields,
    render(values) {
      let out = ''
      for (const part of parts) {
        if ('text' in part) {
          out += part.text
          continue
        }
        const value = lookup(values, part.ref)
        if (value === undefined || value === null) {
          if (part.fallback === undefined) throw new MissingField(part.ref)
          out += part.fallback
          continue
        }
        out += typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)
      }
      return out
    },
  }
}

function lookup(values: Fields, path: string): unknown {
  let cur: unknown = values
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}
