import { describe, expect, it } from 'vitest'
import { compile, MissingField, TemplateError } from '../expression.js'

describe('the mapping language', () => {
  it('renders literal text, references and dotted paths', () => {
    const t = compile('article-${id} in ${row.dept}', 'x')
    expect(t.render({ id: 7, row: { dept: 'legal' } })).toBe('article-7 in legal')
    expect(t.fields).toEqual(['id', 'row.dept'])
  })

  it('takes a default only where one is written, and is a MissingField otherwise', () => {
    expect(compile('${title|untitled}', 'x').render({})).toBe('untitled')
    expect(() => compile('${title}', 'x').render({})).toThrow(MissingField)
    // null is "no value" too — a database column that is NULL has no title.
    expect(compile('${title|none}', 'x').render({ title: null })).toBe('none')
  })

  it('refuses anything that is not a field reference, by the variable it came from', () => {
    for (const bad of ['${a + b}', '${ }', '${A}', '${a..b}', '${fn()}', '${a']) {
      expect(() => compile(bad, 'GIT_LAYER'), bad).toThrow(TemplateError)
      expect(() => compile(bad, 'GIT_LAYER'), bad).toThrow(/GIT_LAYER/)
    }
  })

  it('renders an object field as JSON rather than [object Object]', () => {
    expect(compile('${row}', 'x').render({ row: { a: 1 } })).toBe('{"a":1}')
  })
})
