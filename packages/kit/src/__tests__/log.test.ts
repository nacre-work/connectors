import { describe, expect, it } from 'vitest'
import { redactUrl } from '../log.js'

describe('redactUrl', () => {
  it('strips the userinfo from a URL the standard parser reads', () => {
    expect(redactUrl('https://user:token@nacre.example/v1')).toBe('https://nacre.example/v1')
    expect(redactUrl('postgres://sync:pw@db:5432/corp?sslmode=require')).toBe('postgres://db:5432/corp?sslmode=require')
    expect(redactUrl('mongodb+srv://sync:pw@cluster.example/corp')).toBe('mongodb+srv://cluster.example/corp')
  })

  it('strips it from a host list the standard parser refuses', () => {
    // The replica-set spelling: `new URL` throws on the comma, and the first
    // version of this function then returned the whole string, password
    // included. The case this exists for.
    expect(redactUrl('mongodb://sync:hunter2@a:27017,b:27017/corp?replicaSet=rs0')).toBe('mongodb://a:27017,b:27017/corp?replicaSet=rs0')
    expect(redactUrl('postgres://sync:hunter2@h1:5432,h2:5432/corp')).toBe('postgres://h1:5432,h2:5432/corp')
    // A password carrying an `@` of its own: the cut is at the last `@`
    // before the path, which is the one the parsers also use.
    expect(redactUrl('mongodb://sync:p@ss@a:27017,b:27017/corp')).toBe('mongodb://a:27017,b:27017/corp')
  })

  // libpq, the MySQL drivers and MongoDB all accept a password as a query
  // parameter, and the redacted source is not only logged: it is the `source`
  // the engine writes into every document's metadata, readable by everybody who
  // can read the layer. Clearing the userinfo and leaving `?password=` was a
  // credential in the index.
  it('drops a credential carried in the query, and keeps every other parameter', () => {
    expect(redactUrl('postgres://sync@db:5432/corp?password=hunter2&sslmode=require')).toBe(
      'postgres://db:5432/corp?sslmode=require',
    )
    expect(redactUrl('mysql://db/corp?user=sync&password=hunter2')).toBe('mysql://db/corp?user=sync')
    expect(redactUrl('mongodb://a:27017,b:27017/corp?replicaSet=rs0&authSource=admin&password=hunter2')).toBe(
      'mongodb://a:27017,b:27017/corp?replicaSet=rs0&authSource=admin',
    )
    expect(redactUrl('https://bucket.example/x?X-Amz-Signature=abc&X-Amz-Credential=def&prefix=p')).toBe(
      'https://bucket.example/x?prefix=p',
    )
    expect(redactUrl('https://api.example/v1?access_token=hunter2')).toBe('https://api.example/v1')
  })

  it('leaves a value with no credential alone', () => {
    expect(redactUrl('mongodb://a:27017,b:27017/corp')).toBe('mongodb://a:27017,b:27017/corp')
    expect(redactUrl('/srv/repo.git')).toBe('/srv/repo.git')
    expect(redactUrl('memory')).toBe('memory')
  })

  it('never returns the password for any spelling that carries one', () => {
    for (const v of [
      'imaps://user:hunter2@mail.example:993/INBOX',
      'mongodb://sync:hunter2@a,b,c/corp',
      'postgresql://sync:hunter2@[::1]:5432,h2/corp',
    ]) {
      expect(redactUrl(v)).not.toContain('hunter2')
    }
  })
})
