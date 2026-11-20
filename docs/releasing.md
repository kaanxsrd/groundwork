# Releasing

For maintainers: how `@vante/groundwork` gets from this repository to npm.

| | |
| --- | --- |
| Package | `@vante/groundwork` (public, scoped) |
| What ships | `dist/` (ESM, `.d.ts`, source maps), `README.md`, `LICENSE`, `CHANGELOG.md` |
| Versions | [Changesets](https://github.com/changesets/changesets): each change adds a `.changeset/*.md`, and a release turns them into the version and `CHANGELOG.md` |
| Release tags | `vX.Y.Z`, for example `v0.1.0` |
| Workflow | [`.github/workflows/release.yml`](../.github/workflows/release.yml), on every `v*` tag |

The workflow runs the full suite against Postgres and Redis, checks that the tag matches `package.json` and that no changesets are left unreleased, runs the smoke test on the packed tarball, and publishes with **provenance**: the npm page links to the exact commit and workflow run that built the package.

## Once

1. **npm account.** Sign up at <https://www.npmjs.com/signup> and turn on two-factor authentication for authorization and publishing.
2. **The `vante` scope.** Packages named `@vante/…` need an npm organization (or user) called `vante`. Organizations are free for public packages: <https://www.npmjs.com/org/create>.
3. **A protected environment.** In GitHub, go to **Settings → Environments → New environment** and name it `npm`. Add yourself as a required reviewer, so every publish waits for your approval.

## The first release

npm can only connect a workflow to a package that already exists, so the first release needs a token once. With it, 0.1.0 still gets provenance, because it's published from the workflow.

1. On npmjs.com, create a **granular access token** with read and write access to the `@vante` scope that can publish from CI, and let it expire in a few days.
2. Add it to the `npm` environment as the secret `NPM_TOKEN`.
3. Tag and push (see [Every release](#every-release)).
4. Once 0.1.0 is on npm, connect the workflow: **the package → Settings → Trusted publishing → GitHub Actions**, with repository `kaanxsrd/groundwork`, workflow `release.yml` and environment `npm`.
5. Delete the `NPM_TOKEN` secret and revoke the token. Under **Settings → Publishing access**, choose *Require two-factor authentication and disallow tokens*. From then on only the workflow, or you with 2FA, can publish.

If the workflow can't publish the first time, publish by hand from a clean checkout of the tag (`bun install && bun run build && npm publish --access public`), without provenance, and set up trusted publishing for the next version.

## Every release

```sh
bun x changeset status            # what's going out
bun x changeset version           # bumps package.json, writes CHANGELOG.md, deletes the changesets
bun run check && bun run test     # with bun run db:up
git commit -am "Release v0.2.0"
git tag v0.2.0
git push && git push origin v0.2.0
```

Approve the run under **Actions → Release**. Then check the package page and that `npm view @vante/groundwork version` shows the new version.

## Choosing the version

Until 1.0, a minor version (0.2.0) can break the API, and a patch (0.1.1) never does. Say what breaks in the changeset, and how to update.

## Fixing mistakes

| Situation | What to do |
| --- | --- |
| A release has a bug | Publish a fix as a new patch. Warn about the broken one: `npm deprecate @vante/groundwork@0.2.0 "Breaks X, use 0.2.1"`. |
| Testing before everyone gets it | Publish with `npm publish --tag next`; testers install `@vante/groundwork@next`. `latest` is untouched. |
| Something was published that mustn't be public | `npm unpublish @vante/groundwork@<version>` works within 72 hours if nothing depends on it. The version number can never be reused. If it contained a secret, rotate the secret anyway. |
