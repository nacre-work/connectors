/**
 * A git repository as a source. A bare mirror is kept in the state volume and
 * fetched on every sweep; the listing is `git ls-tree` of the commit the ref
 * points at, and a file's **blob hash is its version** — so a sweep over a
 * repository with ten thousand files reads the content of exactly the ones
 * whose blob moved, and sends those. A path that left the tree is a document
 * that leaves the index, and that is safe here where it is not for the core's
 * `nacre ingest --watch`: that one never deletes because a file vanishing is
 * indistinguishable from the first half of an editor's save, and a commit has
 * no such race.
 *
 * Only blobs. Symlinks and submodules are listed by `ls-tree` too and are
 * skipped by mode, because the content of the first is a path and the content
 * of the second is a commit hash.
 */
import { execFile } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { compile, matchesGlob, type Fields, type Item, type Source, type Template } from '@nacre.work/connector-kit'

const run = promisify(execFile)

export interface LayerRule {
  readonly glob: string
  readonly layer: Template
}

export interface GitSourceOptions {
  readonly url: string
  /** A branch or tag; absent means the remote's HEAD. */
  readonly ref: string | undefined
  readonly dir: string
  readonly include: readonly string[]
  readonly exclude: readonly string[]
  readonly rules: readonly LayerRule[]
  readonly maxBytes: number
  readonly credential: { readonly username: string; readonly token: string } | undefined
}

/** `glob=layer;glob=layer`, first match wins. The right side is a template over the path fields. */
export function parseLayerRules(spec: string, name: string): LayerRule[] {
  const rules: LayerRule[] = []
  for (const part of spec.split(';')) {
    const rule = part.trim()
    if (rule === '') continue
    const eq = rule.indexOf('=')
    if (eq <= 0) throw new Error(`${name}: ${JSON.stringify(rule)} is not glob=layer`)
    rules.push({ glob: rule.slice(0, eq).trim(), layer: compile(rule.slice(eq + 1).trim(), `${name} (${rule.slice(0, eq).trim()})`) })
  }
  if (rules.length === 0) throw new Error(`${name} names no rule; every file needs a layer, written as glob=layer`)
  return rules
}

export function parseGlobs(spec: string): string[] {
  return spec
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g !== '')
}

/** The fields a path offers to every template. */
export function pathFields(path: string): Fields {
  const ext = extname(path)
  const dir = dirname(path)
  return {
    path,
    name: basename(path),
    dir: dir === '.' ? '' : dir,
    ext: ext.startsWith('.') ? ext.slice(1) : ext,
    top: path.includes('/') ? (path.split('/')[0] as string) : '',
  }
}

export class GitSource implements Source {
  #commit = ''

  constructor(private readonly o: GitSourceOptions) {}

  /** The commit the last listing read, for the log. */
  get commit(): string {
    return this.#commit
  }

  /**
   * git refuses a repository owned by another uid, and a source mounted into
   * this container is owned by whoever mounted it — the live run meets that
   * exactly, as `node` reading the runner's bare repository. Trusting the
   * mirror and a local source is the operator's decision, made when they
   * mounted it; the set is those two paths and never `*`.
   *
   * A file rather than `-c`, and that was measured: the local transport
   * starts `upload-pack` with a scrubbed environment, so command-line config
   * never reaches the process that refuses. `GIT_CONFIG_GLOBAL` does.
   */
  get configFile(): string {
    return join(dirname(this.o.dir), 'git.config')
  }

  /** Clone the mirror if it is not there; the ref is fetched on every sweep. */
  async open(): Promise<void> {
    const trusted = [this.o.dir]
    if (this.o.url.startsWith('/') || this.o.url.startsWith('file://')) trusted.push(this.o.url.replace(/^file:\/\//, ''))
    writeFileSync(this.configFile, `[safe]\n${trusted.map((d) => `\tdirectory = ${d}\n`).join('')}`)
    if (!existsSync(this.o.dir)) {
      await this.git(['clone', '--bare', '--quiet', this.o.url, this.o.dir], { withCredential: true, cwd: undefined })
    }
  }

  async *list(): AsyncIterable<Item> {
    const ref = this.o.ref ?? 'HEAD'
    const refspec = this.o.ref === undefined ? '+HEAD:refs/remotes/origin/HEAD' : `+refs/heads/${this.o.ref}:refs/heads/${this.o.ref}`
    await this.git(['fetch', '--quiet', '--force', 'origin', refspec], { withCredential: true })
    const target = this.o.ref === undefined ? 'refs/remotes/origin/HEAD' : `refs/heads/${ref}`
    this.#commit = (await this.git(['rev-parse', target])).trim()

    const { stdout } = await run('git', ['ls-tree', '-r', '-l', '-z', this.#commit], { cwd: this.o.dir, env: this.env(), maxBuffer: 256 * 1024 * 1024 })
    for (const entry of stdout.split('\0')) {
      if (entry === '') continue
      const tab = entry.indexOf('\t')
      const [mode, type, sha, sizeText] = entry.slice(0, tab).split(/\s+/) as [string, string, string, string]
      const path = entry.slice(tab + 1)
      if (type !== 'blob' || mode === '120000') continue
      if (!this.o.include.some((g) => matchesGlob(path, g))) continue
      if (this.o.exclude.some((g) => matchesGlob(path, g))) continue
      const fields = pathFields(path)
      const rule = this.o.rules.find((r) => matchesGlob(path, r.glob))
      const size = Number(sizeText)
      yield {
        id: path,
        version: sha,
        fields: {
          ...fields,
          size,
          blob: sha,
          // Decided at listing time so the engine's unchanged-version path can
          // name the layer without reading the file.
          layer: rule === undefined ? undefined : rule.layer.render(fields),
          ...(rule === undefined ? { skip: 'unmapped', skip_detail: 'no GIT_LAYERS rule matches' } : {}),
        },
      }
    }
  }

  async fetch(item: Item): Promise<Fields> {
    const size = Number(item.fields['size'])
    if (size > this.o.maxBytes) return { skip: 'oversize', skip_detail: `${String(size)} bytes, GIT_MAX_BYTES is ${String(this.o.maxBytes)}` }
    const { stdout } = await run('git', ['cat-file', 'blob', String(item.fields['blob'])], {
      cwd: this.o.dir,
      env: this.env(),
      encoding: 'buffer',
      maxBuffer: this.o.maxBytes + 1024,
    })
    const bytes = stdout as unknown as Buffer
    if (bytes.subarray(0, 8000).includes(0)) return { skip: 'binary', skip_detail: 'a NUL byte in the first 8000' }
    return { content: bytes.toString('utf8') }
  }

  /** Every git this source starts: no prompt, and the config file above. */
  env(): NodeJS.ProcessEnv {
    return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: this.configFile }
  }

  async git(args: string[], opts: { withCredential?: boolean; cwd?: string | undefined } = {}): Promise<string> {
    const env = this.env()
    const argv = [...args]
    if (opts.withCredential && this.o.credential !== undefined) {
      // Through a helper reading the child's own environment, so the token is
      // in no argument list and no remote URL: `ps` and the mirror's config
      // both show nothing.
      env['GIT_CONNECTOR_USERNAME'] = this.o.credential.username
      env['GIT_CONNECTOR_TOKEN'] = this.o.credential.token
      argv.unshift('-c', 'credential.helper=!f() { echo "username=$GIT_CONNECTOR_USERNAME"; echo "password=$GIT_CONNECTOR_TOKEN"; }; f')
    }
    const cwd = 'cwd' in opts ? opts.cwd : this.o.dir
    const { stdout } = await run('git', argv, { ...(cwd === undefined ? {} : { cwd }), env, maxBuffer: 64 * 1024 * 1024 })
    return stdout
  }
}
