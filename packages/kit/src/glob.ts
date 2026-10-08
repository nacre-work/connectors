// Double-star, star and question mark over slash-separated paths, and nothing
// more: enough to say "every file under docs" and "every .ts file under src",
// small enough to be read whole. Star and question mark never cross a slash;
// double-star matches any number of segments, including none. Written here
// rather than taken from a package because a glob is the one input that
// decides which files leave a repository.
//
// (Line comments, because a doc comment cannot spell "double-star slash star"
// without ending itself.)
export function globToRegExp(glob: string): RegExp {
  let re = '^'
  let i = 0
  while (i < glob.length) {
    const c = glob[i] as string
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // double-star then slash: zero or more whole segments; a trailing double-star: the rest.
        if (glob[i + 2] === '/') {
          re += '(?:[^/]+/)*'
          i += 3
        } else {
          re += '.*'
          i += 2
        }
      } else {
        re += '[^/]*'
        i += 1
      }
    } else if (c === '?') {
      re += '[^/]'
      i += 1
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      i += 1
    }
  }
  return new RegExp(`${re}$`)
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path)
}
