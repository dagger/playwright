# playwright

A [Dagger](https://dagger.io) module — written in the `.dang` module language —
that runs [Playwright](https://playwright.dev) browser tests against your
project, with first-class [workspace service
wiring](https://docs.dagger.io/config/module-wiring): point it at any module
function that returns a `Service` and your tests run against it.

Requires Dagger engine `v1.0.0-beta.15` or later. beta.15 is not released
yet, so for now the module only loads on a dev engine; a released engine fails
to load it.

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
| `installDir`   | Where dependencies are installed: the nearest `package.json` at or above the project. |
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
dagger check --playwright --test --playwright-project=apps/web   # as flags
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
failing run lists every run that failed. `--test` alone also selects every
other installed module's check named `test`; `--playwright` narrows it to
this one. `dagger check --help` lists the flags in effect:
`--playwright-project PATH`, `--playwright-projects`,
`--playwright-test-file PATH` and `--playwright-test-files`.

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

The config object must be written as `defineConfig({ … })`,
`export default { … }` or `module.exports = { … }`. Anything else falls back
to Playwright's defaults for that setting — `testDir` is the config's
directory, `testMatch` is `**/*.@(spec|test).?(c|m)[jt]s?(x)`, and nothing is
ignored:

- values built from variables, environment variables, function calls,
  template strings with `${}`, or imports;
- settings that only come from a spread (`...base`), which is ignored;
- regexes RE2 cannot compile (lookaround, backreferences) and `!(…)` globs;
- a config that can't be read or doesn't look like the shapes above.

Listing never fails because of a config. Other limits of static discovery:
empty test files are not listed; `respectGitIgnore` is not applied; and a key
that Playwright itself does not treat as a test (because of a setting that
was not read) fails its run with "No tests found".

### Whole and filtered runs

A test-file check runs as one batch per project over the selected files:

- **Nothing filtered out** (the whole project, e.g. a bare `dagger check`):
  Playwright runs the project natively with its own config, split with
  `--shard=i/N` across N containers, where N is the `shards` setting. Tests
  static discovery missed still run.
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
Playwright tests failed in apps/web:
- tests/a.spec.ts, tests/aa.spec.ts: exit code: 1
```

The `runs` function on the test files returns the containers a batch would
start (`shard` for a whole run, `files` for a group).

Other artifacts per project:

```sh
# a shell in the prepared test container
dagger shell playwright/projects/base --playwright-project=apps/web
# export the HTML report after a failing run
dagger api call playwright project --path=apps/web report export --path=./playwright-report
```

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

Dependencies are installed at the nearest `package.json` at or above the
project, so a project without its own `package.json` installs from its
monorepo root. When the workspace has none at all, the install is skipped
and `npx` fetches Playwright on demand.

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
tests to use.

## Settings

Configured under `[modules.playwright.settings]` in `dagger.toml` (or as flags
on `dagger api call playwright`). They apply to every project:

- **`service`**: DAG address (`"dag://<module>/<function>"`) of the service
  under test.
- **`serviceHostname`** (default `frontend`): hostname the service is bound as.
- **`baseImageAddress`** (default: derive): the image tests run in. By default
  it is derived from your project's `@playwright/test` version
  (`mcr.microsoft.com/playwright:v<version>-noble`), so browsers always match
  your Playwright version. Derivation prefers the version installed per
  `package-lock.json`; without a lockfile it falls back to the version
  declared in `package.json`, so pin that exactly — a floating range like
  `^1.58.2` can install a newer Playwright than the derived image's browsers.
- **`baseCtr`**: a full `Container` override, also wireable
  (`baseCtr = "dag://base-images/chromium"`). `npx playwright` must work in it after
  dependency install.
- **`packageManager`** (default `npm`): how project dependencies are installed
  (`npm`, `yarn`, `pnpm`, `bun`). yarn and pnpm are enabled via corepack.
- **`localhostProxy`** (default `false`): see secure contexts above.
- **`args`** (default `[]`): extra arguments for every `playwright test`
  invocation, e.g. `["--project", "chromium"]`.
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
project per rule) and filtered runs (exact file selection, groups, failures).
`dagger check` exercises discovery (including working-directory scoping),
lookups, both collections (keys, `get`, `subset`, batches), static config
reading, whole and filtered runs, version derivation, service wiring, the
localhost proxy, and sharding end to end.
