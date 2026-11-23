# Releasing

For maintainers: how `@vantedev/groundwork` gets from this repository to npm.

| | |
| --- | --- |
| Package | `@vantedev/groundwork` (public, scoped) |
| What ships | `dist/` (ESM, `.d.ts`, source maps), `README.md`, `LICENSE`, `CHANGELOG.md` |
| Versions | [Changesets](https://github.com/changesets/changesets): each change adds a `.changeset/*.md`, and a release turns them into the version and `CHANGELOG.md` |
| Release tags | `vX.Y.Z`, for example `v0.1.0` |
| Workflow | [`.github/workflows/release.yml`](../.github/workflows/release.yml), on every `v*` tag |

The workflow runs the full suite against Postgres and Redis, checks that the tag matches `package.json` and that no changesets are left unreleased, runs the smoke test on the packed tarball, and publishes with **provenance**: the npm page links to the exact commit and workflow run that built the package.

## Once

1. **npm account.** The package is published under the `vantedev` npm user, which owns the `@vantedev` scope; no organization is needed. Two-factor authentication must be on for authorization and publishing.
2. **A protected environment.** In GitHub, go to **Settings → Environments → New environment** and name it `npm`. Add yourself as a required reviewer, so every publish waits for your approval.

## The first release

npm can only connect a workflow to a package that already exists, so the first release is published by hand, as VaultDrop's CLI was. It has no provenance; every later release does.

1. Log in as `vantedev`: `npm login`, then check with `npm whoami`.
2. From a clean checkout of the release commit, run the checks and look at what will ship:

   ```sh
   bun install --frozen-lockfile && bun run db:up
   bun run check && bun run test && bun run smoke
   npm publish --dry-run --access public
   ```

3. Publish with `npm publish --access public` (npm asks for your 2FA code), then confirm with `npm view @vantedev/groundwork version`.
4. Tag the commit `v0.1.0` and push the tag. The workflow runs the full suite, sees the version is already on npm, and skips publishing.
5. Connect the workflow for later releases: **the package → Settings → Trusted publishing → GitHub Actions**, with repository `kaanxsrd/groundwork`, workflow `release.yml` and environment `npm`.
6. Under **Settings → Publishing access**, choose *Require two-factor authentication and disallow tokens*. From then on only the workflow, or you with 2FA, can publish.

The workflow only uses trusted publishing: it reads no `NPM_TOKEN`, so a token left in the `npm` environment does nothing. Check the connection with `npm trust list @vantedev/groundwork`. The repository, the workflow file (`release.yml`, the bare name) and the environment (`npm`) must match exactly.

## Every release

```sh
bun x changeset status            # what's going out
bun x changeset version           # bumps package.json, writes CHANGELOG.md, deletes the changesets
bun run check && bun run test     # with bun run db:up
git commit -am "chore(release): Version 0.2.0"
git tag v0.2.0
git push && git push origin v0.2.0
```

Approve the run under **Actions → Release**. Then check the package page and that `npm view @vantedev/groundwork version` shows the new version.

## Choosing the version

Until 1.0, a minor version (0.2.0) can break the API, and a patch (0.1.1) never does. Say what breaks in the changeset, and how to update.

## Fixing mistakes

| Situation | What to do |
| --- | --- |
| Publishing fails with `ENEEDAUTH` | The OIDC exchange failed. The workflow's last step prints npm's reason. Usually the trusted publisher doesn't match: check it with `npm trust list @vantedev/groundwork`, and fix it with `npm trust github @vantedev/groundwork --file release.yml --repo kaanxsrd/groundwork --env npm --allow-publish`. Then re-run the failed job from the run page; the tag stays. |
| A release has a bug | Publish a fix as a new patch. Warn about the broken one: `npm deprecate @vantedev/groundwork@0.2.0 "Breaks X, use 0.2.1"`. |
| Testing before everyone gets it | Publish with `npm publish --tag next`; testers install `@vantedev/groundwork@next`. `latest` is untouched. |
| Something was published that mustn't be public | `npm unpublish @vantedev/groundwork@<version>` works within 72 hours if nothing depends on it. The version number can never be reused. If it contained a secret, rotate the secret anyway. |
