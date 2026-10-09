# Contributing

## Language

**English, American spelling, everywhere.** Code, comments, commit messages,
branch names, issues, pull requests, and documentation.

## Before you write code

For a new connector, open an issue first. A connector is not written until
`scripts/ci/live.sh` has watched its add, its change and its removal arrive in
a search against a real Nacre — so the question worth settling before the code
is what the source offers as an identity, a version and a complete listing.

## Process

1. Fork, branch from `main`.
2. `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test`.
3. Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`.
4. Open a pull request using the template. One pull request, one topic.
5. Squash merge, linear history.

## Contribution license

Contributions are covered by the **Contributor License Agreement** in
[CLA.md](./CLA.md) — the same agreement as the Nacre core, byte for byte, and
`lint:cla` holds the copy. The counterparty is **I/E Siarhei Dudko**, an
Individual Entrepreneur registered in Georgia — the country — trading as Nacre,
and the agreement is governed by Georgian law.

**You keep the copyright in what you write.** This is not an assignment. What
the agreement adds on top of Apache 2.0 is the right to sublicense. It cannot
take back any licence already granted: every Apache 2.0 release stays Apache
2.0, permanently.

If your employer has rights to what you write — which is more often true than
people expect — section 4 of the agreement is the one to read before you sign.

### Signing

No third-party service, no account, nothing that leaves this repository. Open a
pull request that adds you to `.github/cla/signatures.json` and changes nothing
else:

```json
{
  "github": "your-github-username",
  "name": "Your Full Name",
  "emails": ["every@address.you", "author@commits.from"],
  "version": "1.0",
  "date": "2026-10-09"
}
```

with this in the body:

> I have read the Nacre Contributor License Agreement version 1.0 and I agree to
> it for my present and future Contributions to Nacre.

**A signature in the core's list does not carry over.** It is the same
agreement, but each repository's `cla` job reads its own list from its own base
branch — a gate that reached into another repository would be a network call
inside an authorization check — so somebody contributing to both signs in both.

List every address you commit from. The `cla` job compares commit metadata, not
GitHub accounts, so an unlisted address reads as an unsigned contributor.

A pull request touching only that file skips the `cla` job, because otherwise
signing would be blocked by the check it exists to satisfy. That is safe: the
job reads the signature list from the base branch and never from the pull
request under test, so a contribution cannot approve itself.

Your actual work can be opened before or after signing — it just will not merge
until the signature does.
