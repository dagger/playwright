# playwright

A [Dagger](https://dagger.io) module — written in the `.dang` module language —
that runs [Playwright](https://playwright.dev) browser tests against your
project, with first-class [workspace service
wiring](https://docs.dagger.io/config/module-wiring): point it at any module
function that returns a `Service` and your tests run against it.

Requires Dagger v1.0.0-beta.15 or later.

## Functions

| Function   | Description                                                      |
| ---------- | ---------------------------------------------------------------- |
| `projects` | Playwright projects at or below the working directory, as a collection keyed by config directory. |
| `project`  | The Playwright project containing a workspace path.              |

On a project:

| Function       | Description                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| `tests`        | The project's test files, as a collection keyed by project-relative path.    |
| `test`         | Run the whole project, sharded across parallel containers (a plain function; the checks are per test file). |
| `report`       | Run the tests tolerating failures; returns the HTML report `Directory`.       |
| `base`         | The prepared test container (workspace mounted, deps installed, service bound). |
| `imageAddress` | The resolved Playwright image (useful to debug version derivation).           |
| `playwrightVersion` | The `@playwright/test` version the image is derived from.               |
| `installDir`   | Where dependencies are installed (see [Dependencies](#dependencies)).        |
| `packageManager` | The package manager that installs them.                                    |
| `path`         | The project's config directory, relative to the workspace root.              |

On the test files: `test` (the check, run as one batch over the selection) and
`runs` (the containers that batch would start; see [Shards and
groups](#shards-and-groups)). On a test file: `path` and `test`.

## Usage

Install the module in your workspace:

```sh
dagger install github.com/dagger/playwright
```

Run the tests:

```sh
dagger check                                        # every check in the workspace
dagger check playwright/projects/tests/test         # every Playwright project
dagger check playwright/projects/tests/test --playwright-project=apps/web
dagger check playwright/projects/tests/test --playwright-project=apps/web \
  --playwright-test-file=tests/login.spec.ts        # one file
dagger check --playwright --check test --playwright-project=apps/web   # as flags
```

## Projects

Every directory holding a `playwright.config.{ts,js,mjs,cjs,mts,cts}` is a
project, keyed by that directory relative to the workspace root (`.` for the
root itself). These are directories, not the browser `projects` inside a
config (`chromium`, `firefox`, …); pick those with `args`. `projects` is a
collection, so it adds a `playwright-project` dimension to `dagger check`,
`dagger list` and `dagger shell`. Each project's test files are a nested
collection, which adds a `playwright-test-file` dimension under it:

```console
$ dagger list playwright-projects -a                # every project's key
$ dagger list playwright-test-files -a --playwright-project=apps/web
$ dagger check -l --all --playwright                # one line per test file
$ dagger check -l --all --playwright -f=cli         # the same, as reusable flags
$ dagger check playwright/projects/tests/test --playwright-project=apps/web --playwright-project=apps/admin
```

The selected projects run concurrently, each in its own containers, and a
failing run lists every run that failed. `--check test` alone also selects
every other installed module's check named `test`; `--playwright` narrows it
to this one. `dagger check --help` lists the flags in effect:
`--playwright-project PATH`, `--playwright-projects`,
`--playwright-test-file PATH` and `--playwright-tests`.

### Discovery

Keys come from a single walk of the workspace for config file names
(`Workspace.findRoots`), with `node_modules` and hidden directories pruned
from the walk. Listing projects reads no file contents and runs no container
or `npx`, so it stays fast in large monorepos. Because discovery is static:

- a config is a project whether or not it is a real suite — a shared base
  config named `playwright.config.ts` is listed too;
- configs with other names (`playwright.ct.config.ts`, a custom `--config`
  path) are not discovered;
- configs inside `node_modules` or hidden directories are never listed.

## Test files

A project's test files are keyed by their path relative to the project
directory (`tests/login.spec.ts`). Keys are the files Playwright would load,
read statically from the project's `playwright.config` — no container, `npx`
or Node runs to list them. One `Workspace.search` (ripgrep) per project finds
the candidates; `node_modules` and `.git` are pruned by the search itself, and
files under a nested project (a subdirectory with its own
`playwright.config`) belong to that project, not this one.

### What is read from the config

The config file is read as text and only **literal** values are honoured:

- `testDir`: a string literal, or `path.join(__dirname, '…')` /
  `path.resolve(__dirname, '…')` with string literals, resolved against the
  config's directory.
- `testMatch` and `testIgnore`: a string literal (a glob), a regex literal
  (`/…/flags`), or an array of those. Globs follow Playwright's rules
  (minimatch, case-insensitive, `**/` prepended unless present); regexes are
  matched against the file's absolute path in the test container
  (`/app/<workspace path>`).
- The same three settings inside each entry of `projects: [{ … }]`. A
  Playwright project without its own value inherits the top-level one. Keys
  are the union across Playwright projects: files are the dimension, not
  browser projects.

The config object is found where the config's default export is:

- `export default defineConfig({ … })`, `export default { … }` or
  `module.exports = { … }`;
- `export default config` (or `defineConfig(config)`) naming a `const` in
  the same file, TypeScript annotation included
  (`const config: PlaywrightTestConfig = { … }`);
- one hop of a relative import: `export { config as default } from
  '../../utils.js'`, `export default base` with `import base from './base'`.

One identifier spread into the object (`defineConfig({ ...config, webServer
})`) is read the same way — a `const` in the file or a relative import — and
the object's own keys override it, as in JavaScript. The imported object's
own imports and spreads are not followed. A `testDir` in an imported object
resolves against the config's directory, as Playwright does, unless it uses
`__dirname`.

Anything else falls back to Playwright's defaults for that setting —
`testDir` is the config's directory, `testMatch` is
`**/*.@(spec|test).?(c|m)[jt]s?(x)`, and nothing is ignored:

- values built from variables, environment variables, function calls or
  template strings with `${}`;
- imports of packages (not relative paths) and anything more than one hop
  away;
- regexes RE2 cannot compile (lookaround, backreferences) and `!(…)` globs;
- quoted keys (`'testDir': …`);
- a config that can't be read or doesn't look like the shapes above.

Listing never fails because of a config. A project where static discovery
finds no test file at all still gets one key, `.`, which runs the whole
project natively, so it can always be checked. Other limits: empty test
files are not listed; `respectGitIgnore` is not applied; and a key that
Playwright itself does not treat as a test (because of a setting that was not
read) fails its run with "No tests found".

### Whole and filtered runs

A test-file check runs as one batch per project over the selected files:

- **Nothing filtered out** (the whole project, e.g. a bare `dagger check`, or
  every one of a project's keys selected by name): Playwright runs the
  project natively with its own config, split with `--shard=i/N` across N
  containers, where N is the `shards` setting. Tests static discovery missed
  still run.
- **Some files selected** (`--playwright-test-file=…`): only those files run.
  Each is passed as an anchored, escaped regex of its absolute path
  (`^/app/apps/web/tests/a\.spec\.ts$`), because Playwright reads positional
  arguments as regexes — a plain `a.spec.ts` would also run `aa.spec.ts`.
- **Nothing selected**: nothing runs.

### Shards and groups

A filtered run splits the selected files, in key order, into up to `shards`
contiguous groups of near-equal size, one container per group, all running
concurrently: with `shards = 2`, three files run as `[a, b]` and `[c]`, and a
single file runs in one container. A whole run uses `--shard` instead. Either
way, every container binds the same service, and a failure lists every
failing shard or group:

```
Playwright failed in apps/web:
- tests/a.spec.ts, tests/aa.spec.ts: playwright test failed (exit 1):
  …the end of the output…
```

A failing install is named as such (`install failed (pnpm install, exit 1):`
with the end of its output), and so is a project without Playwright
installed.

The `runs` function on the test files returns the containers a batch would
start (`shard` for a whole run, `files` for a group).

Other artifacts per project:

```sh
# a shell in the prepared test container
dagger shell playwright/projects/base --playwright-project=apps/web
# export the HTML report after a failing run
dagger api call playwright project --path=apps/web report export --path=./playwright-report
```

`report` runs the whole project once with `--reporter=list,html`, so the HTML
report exists whatever reporters the config sets.

## Working directory awareness

Which projects are keys depends on where you run the command:

- **inside a project's subdirectory** — just the nearest enclosing project;
- **at a project's root** — that project and any projects below it;
- **anywhere else** — the projects below your directory.

So running from anywhere inside a project selects it with no flags:

```console
$ cd apps/web/src && dagger check        # runs apps/web only
$ dagger check -l --all                  # from apps/web/src: lists apps/web only
```

The `project` lookup takes a path relative to your current directory
(absolute paths resolve from the workspace root) and returns the nearest
project at or above it. The whole workspace is still mounted into the test
container, with the project directory as the working directory, so
configuration and dependencies that live above the project — monorepo roots,
shared configs — keep resolving.

## Dependencies

Dependencies are installed once per project at its **install root**: the
nearest workspace root at or above the project (a directory with
`pnpm-workspace.yaml`, or a `package.json` with `"workspaces"`), else the
nearest directory with a lockfile, else the nearest `package.json`. So a
package in a pnpm or yarn workspace gets `workspace:` and `catalog:`
dependencies, and a project without its own `package.json` installs from its
monorepo root.

- **Package manager:** the `packageManager` setting, else the install root's
  `package.json` `"packageManager"` field, else its lockfile
  (`pnpm-lock.yaml` or `pnpm-workspace.yaml` → pnpm, `yarn.lock` → yarn,
  `bun.lock` → bun), else npm. pnpm and yarn come from corepack (installed
  first if the image lacks it), which honours the version in
  `"packageManager"`.
- **Caching:** the install step sees only what an install reads — every
  `package.json`, lockfiles, `pnpm-workspace.yaml`, `.npmrc`/`.yarnrc*`,
  `.yarn/` releases and plugins, `patches/`, the directories of `file:`,
  `link:`, `portal:` and injected dependencies, and workspace packages' `bin`
  files — and the rest of the source is laid over it afterwards, so editing a
  test or source file doesn't re-run the install. The npm, pnpm store, yarn,
  bun and corepack caches live on cache volumes.
- **Lifecycle scripts** (`prepare`, `postinstall`, …) run during the install,
  before the rest of the source is there. A script that builds from source
  fails — reported as `install failed (…, exit N)` with the end of its output
  — or leaves a half-built package. Skip them with
  `installFlags = ["--ignore-scripts"]` and build with the full source
  instead: in the `setup` setting (`setup = ["pnpm --filter @acme/sdk
  build"]`), which runs before the tests, or in your config's
  `webServer.command` (`pnpm build && pnpm preview`) when no service is
  wired.
- **Playwright itself:** tests run the project's own
  `node_modules/.bin/playwright` (the nearest between the project and the
  install root, or `yarn playwright` under Plug'n'Play), never a version `npx`
  fetches. A project without `@playwright/test` installed fails with a message
  saying where to add it. Only a workspace with no `package.json` at all falls
  back to `npx playwright`.

The Playwright image is derived from the `@playwright/test` version the
install root's lockfile resolves (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock`
or `package-lock.json`), else the version the nearest `package.json` that
declares it asks for — `catalog:` and `catalog:<name>` resolved from
`pnpm-workspace.yaml`. A range is read as its lower bound; anything that is
not a version (`workspace:*`, a URL) falls back to the module's pinned image,
never to an invalid image reference.

## Wiring a service under test

If another module in your workspace serves your app, wire it into the tests in
`dagger.toml` — no glue module needed:

```toml
[modules.playwright.settings]
service = "dag://myapp/serve"
```

The value is a DAG address, `dag://<module>/<function>`, naming any installed
module's function that returns a `Service` (`dagger list services` lists
them). A bare `"myapp:serve"` is no longer read as a module reference.

The service is bound into the test container of every project as `frontend`
(configurable via `serviceHostname`) and `PLAYWRIGHT_BASE_URL` is set to its
first exposed port. Settings apply to every project the module runs; to test
projects with different services, install the module twice under different
names.

**Your `playwright.config` must consume it:**

```ts
use: {
  baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
},
```

Without a wired service, no binding happens and your config's own `webServer`
(or hardcoded `baseURL`) is used as-is.

### Secure contexts (service workers, WebCrypto, PWA testing)

Browser APIs that require a [secure
context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)
don't work against `http://frontend:<port>` — only `localhost` or HTTPS
origins qualify. Enable the localhost proxy to reach the wired service on a
secure-context origin:

```toml
[modules.playwright.settings]
service = "dag://myapp/serve"
localhostProxy = true
```

This proxies `localhost:<port>` to the service (via socat, installed with apt —
the default images qualify) and sets `PLAYWRIGHT_LOCALHOST_BASE_URL` for your
tests to use. The proxy listens on both `127.0.0.1` and `[::1]` (IPv4 only
in a container without IPv6), so tests that hardcode a loopback address
reach the service too.

## Settings

Configured under `[modules.playwright.settings]` in `dagger.toml`, or with
`dagger settings` (`dagger settings playwright shards 2`; `dagger settings -u
playwright shards` unsets it), or as flags on `dagger api call playwright`.
They apply to every project:

- **`service`**: DAG address (`"dag://<module>/<function>"`) of the service
  under test.
- **`serviceHostname`** (default `frontend`): hostname the service is bound as.
- **`baseImageAddress`** (default: derive): the image tests run in. By default
  it is derived from your project's `@playwright/test` version
  (`mcr.microsoft.com/playwright:v<version>-noble`, see
  [Dependencies](#dependencies)), so browsers match your Playwright version.
  Without a lockfile, pin the version exactly — a range like `^1.58.2` can
  install a newer Playwright than the derived image's browsers.
- **`baseCtr`**: a full `Container` override, also wireable
  (`baseCtr = "dag://base-images/chromium"`). It needs Node, and the browsers
  your installed Playwright expects.
- **`packageManager`** (default: detect): `npm`, `yarn`, `pnpm` or `bun`;
  empty detects it per project (see [Dependencies](#dependencies)).
- **`installFlags`** (default `[]`): extra arguments for the install command,
  e.g. `["--ignore-scripts"]`.
- **`environment`** (default `[]`): environment variables for the test
  containers, as `KEY=VALUE`, e.g. `["DEBUG=pw:api"]`.
- **`localhostProxy`** (default `false`): see secure contexts above.
- **`args`** (default `[]`): extra arguments for every `playwright test`
  invocation, e.g. `["--project", "chromium"]`. They come after the module's
  own arguments, so a flag that takes several values doesn't swallow the
  file filters.
- **`setup`** (default `[]`): shell commands run in the project directory
  after dependencies are installed and the full source is in place, before
  the tests, e.g. `["pnpm --filter @acme/sdk build"]` to build a workspace
  package the tests import. They run once per project, shared by its shards.
- **`shards`** (default `1`): number of parallel containers each project's
  tests run in: `--shard=i/N` for a whole run, up to N groups of files for a
  filtered one (see [Sharding](#sharding)).

Two things to know about the test environment:

- The module sets `CI=true`, so anything your `playwright.config` keys off
  `process.env.CI` (workers, retries, `forbidOnly`) applies. In particular,
  a `workers: process.env.CI ? 1 : undefined` clamp serializes the whole
  suite — prefer a bounded value like `4` (the container is isolated, but
  unbounded workers can starve the browsers and blow test timeouts).
- Branded browser channels (`msedge`, `chrome`) are not present in the
  Playwright images — remove those projects or scope runs with `args`.

## Sharding

```toml
[modules.playwright.settings]
shards = 4
```

A whole run starts one container per shard (`--shard=i/4`); a filtered run
splits the selected files into up to 4 groups (see [Shards and
groups](#shards-and-groups)). All of them run in parallel against the same
wired service, and every failing shard or group is reported. (`report` is
single-run; shard report merging is not yet supported.)

## Using it from another module

From your own module, `projects(ws)` is the collection of projects and
`tests(ws)` on a project the collection of its test files: each has `keys`,
`get(key:)`, `subset(keys:)`, and `batch` for running a function over the
selection. The test-file `test` is a check, and a check called through a
dependency comes back as a `Check` that has not run, so wrap it. The
project-level `test` functions are plain and run when called:

```dang
type Ci {
  let run(check: Check!): Void {
    if (check.pass == false) {
      raise check.error.message ?? "check failed"
    }
    null
  }

  e2e(ws: Workspace!): Void @check {
    let projects = playwright(service: myapp.serve, shards: 2).projects(ws)
    let web = projects.get(key: "apps/web").tests(ws)
    run(web.batch.test(ws))                                         # all of apps/web, sharded
    run(web.subset(keys: ["tests/login.spec.ts"]).batch.test(ws))   # some files
    run(web.get(key: "tests/login.spec.ts").test(ws))               # one file
    projects.batch.test(ws)                                         # every project, whole
    null
  }

  webReport(ws: Workspace!): Directory! {
    playwright.project(ws, "apps/web").report(ws)
  }
}
```

## Development

This repo is its own e2e fixture: `.dagger/modules/e2e` runs the module
against two minimal Playwright projects — `fixture/`, with
`.dagger/modules/fixtures`' static server bound as the service under test, and
`fixture/nested/`, which has no `package.json` of its own and installs from
the enclosing one. Small synthetic workspaces cover config reading (one
project per rule, including SvelteKit's and React Router's config shapes),
install roots, package managers and image derivation, installs with pnpm,
`installFlags` and `environment`, and filtered runs (exact file selection,
groups, failures).
`dagger check` exercises discovery (including working-directory scoping),
lookups, both collections (keys, `get`, `subset`, batches), static config
reading, whole and filtered runs, version derivation, service wiring, the
localhost proxy, and sharding end to end.
