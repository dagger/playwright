# playwright

A [Dagger](https://dagger.io) module — written in the `.dang` module language —
that runs [Playwright](https://playwright.dev) browser tests against your
project, with first-class [workspace service
wiring](https://docs.dagger.io/config/module-wiring): point it at any module
function that returns a `Service` and your tests run against it.

Requires Dagger engine `v1.0.0-beta.15` or later.

## Functions

| Function   | Description                                                      |
| ---------- | ---------------------------------------------------------------- |
| `projects` | Playwright projects in the workspace, as a collection keyed by config directory. |
| `project`  | The Playwright project containing a workspace path.              |

On a project:

| Function       | Description                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| `test`         | Run the project's tests, optionally sharded across parallel containers (a check). |
| `report`       | Run the tests tolerating failures; returns the HTML report `Directory`.       |
| `base`         | The prepared test container (workspace mounted, deps installed, service bound). |
| `imageAddress` | The resolved Playwright image (useful to debug version derivation).           |
| `installDir`   | Where dependencies are installed: the nearest `package.json` at or above the project. |
| `path`         | The project's config directory, relative to the workspace root.              |

## Usage

Install the module in your workspace:

```sh
dagger install github.com/dagger/playwright
```

Run the tests:

```sh
dagger check                                  # every check in the workspace
dagger check playwright/projects/test         # every Playwright project
dagger check playwright/projects/test --playwright-project=apps/web
dagger check --playwright --test --playwright-project=apps/web   # same, as flags
```

## Projects

Every directory holding a `playwright.config.{ts,js,mjs,cjs,mts,cts}` is a
Playwright project, keyed by that directory relative to the workspace root
(`.` for the root itself). `projects` is a collection, so it adds a
`playwright-project` dimension to `dagger check`, `dagger list` and
`dagger shell`:

```console
$ dagger list playwright-projects -a                # every project's key
$ dagger check -l --all --playwright                # one line per project
$ dagger check -l --all --playwright -f=cli         # the same, as reusable flags
$ dagger check playwright/projects/test --playwright-project=apps/web --playwright-project=apps/admin
```

The selected projects run concurrently, each in its own containers, and a
failing run lists every project that failed. `--test` alone also selects
every other installed module's check named `test`; `--playwright` narrows it
to this one. `dagger check --help` lists the flags in effect.

Discovery reads the workspace tree only — listing projects runs no container.
It skips `node_modules` and hidden directories.

Other artifacts per project:

```sh
# a shell in the prepared test container
dagger shell playwright/projects/base --playwright-project=apps/web
# export the HTML report after a failing run
dagger api call playwright project --path=apps/web report export --path=./playwright-report
```

## Working directory awareness

The module is aware of where in the workspace you invoke it: discovery
finds projects at or below your current directory, plus the project
enclosing it, so `cd apps/web && dagger check` (or
`dagger -W ./apps/web check`) runs just that project. The `project` lookup
takes a path relative to your current directory (absolute paths resolve from
the workspace root) and returns the nearest project at or above it. The whole
workspace is still mounted into the test container, with the project
directory as the working directory, so configuration and dependencies that
live above the project — monorepo roots, shared configs — keep resolving.

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
- **`shards`** (default `1`): number of parallel shard containers each
  project's `test` runs — this is how you shard the `playwright/projects/test`
  check.

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

Shards run in parallel containers against the same wired service and fail fast
on the first failing shard. (`report` is single-run; shard report merging is
not yet supported.)

## Development

This repo is its own e2e fixture: `.dagger/modules/e2e` runs the toolchain
against two minimal Playwright projects — `fixture/`, with
`.dagger/modules/fixtures`' static server bound as the service under test, and
`fixture/nested/`, which has no `package.json` of its own and installs from
the enclosing one. `dagger check` exercises discovery, lookups, the projects
collection (keys, `get`, `subset`, batches), version derivation, service
wiring, the localhost proxy, and sharding end to end.
