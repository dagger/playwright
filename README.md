# playwright

A [Dagger](https://dagger.io) module — written in the `.dang` module language —
that runs [Playwright](https://playwright.dev) browser tests against your
project, with first-class [workspace service
wiring](https://docs.dagger.io/reference/configuration/workspace): point it at
any module function that returns a `Service` and your tests run against it.

## Functions

| Function       | Description                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| `test`         | Run the test suite, optionally sharded across parallel containers (a `@check`). |
| `report`       | Run the suite tolerating failures; returns the HTML report `Directory`.       |
| `base`         | The prepared test container (workspace mounted, deps installed, service bound). |
| `imageAddress` | The resolved Playwright image (useful to debug version derivation).           |

## Usage

Install the module in your workspace:

```sh
dagger install github.com/dagger/playwright
```

Run the tests:

```sh
dagger check                  # run every check in the workspace
dagger check playwright:test  # just the Playwright suite
```

Export the HTML report after a failing run:

```sh
dagger api call playwright report -o ./playwright-report
```

## Working directory awareness

The module is aware of where in the workspace you invoke it: project discovery
searches for `playwright.config.*` at or below your current directory, and
`sourcePath` resolves relative to it (absolute paths resolve from the
workspace root). The whole workspace is still mounted into the test container,
with the project directory as the working directory, so configuration and
dependencies that live above the project — monorepo roots, shared configs —
keep resolving.

Dependencies are installed at the nearest `package.json` at or above the
project, so a project without its own `package.json` installs from its
monorepo root. When the workspace has none at all, the install is skipped
and `npx` fetches Playwright on demand.

## Wiring a service under test

If another module in your workspace serves your app, wire it into the tests in
`dagger.toml` — no glue module needed:

```toml
[modules.playwright.settings]
service = "myapp:serve"
```

The service is bound into the test container as `frontend` (configurable via
`serviceHostname`) and `PLAYWRIGHT_BASE_URL` is set to its first exposed port.

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
service = "myapp:serve"
localhostProxy = true
```

This proxies `localhost:<port>` to the service (via socat, installed with apt —
the default images qualify) and sets `PLAYWRIGHT_LOCALHOST_BASE_URL` for your
tests to use.

## Settings

Configured under `[modules.playwright.settings]` in `dagger.toml` (or as flags
on `dagger api call playwright`):

- **`sourcePath`** (default: discover): path of the Playwright project,
  relative to your current directory (absolute paths resolve from the
  workspace root). By default the module finds the directory containing
  `playwright.config.*` at or below your current directory; setting this is
  required when the workspace holds more than one Playwright project.
- **`service`**: module reference (`"module:function"`) of the service under
  test.
- **`serviceHostname`** (default `frontend`): hostname the service is bound as.
- **`baseImageAddress`** (default: derive): the image tests run in. By default
  it is derived from your project's `@playwright/test` version
  (`mcr.microsoft.com/playwright:v<version>-noble`), so browsers always match
  your Playwright version. Derivation prefers the version installed per
  `package-lock.json`; without a lockfile it falls back to the version
  declared in `package.json`, so pin that exactly — a floating range like
  `^1.58.2` can install a newer Playwright than the derived image's browsers.
- **`baseCtr`**: a full `Container` override, also wireable
  (`baseCtr = "base-images:chromium"`). `npx playwright` must work in it after
  dependency install.
- **`packageManager`** (default `npm`): how project dependencies are installed
  (`npm`, `yarn`, `pnpm`, `bun`). yarn and pnpm are enabled via corepack.
- **`localhostProxy`** (default `false`): see secure contexts above.
- **`args`** (default `[]`): extra arguments for every `playwright test`
  invocation, e.g. `["--project", "chromium"]`.
- **`shards`** (default `1`): number of parallel shard containers `test` runs —
  this is how you shard the `playwright:test` check.

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

This repo is its own e2e fixture: the workspace wires
`.dagger/modules/fixtures`' static server into the module
(`settings.service = "fixtures:server"`) and `fixture/` holds a minimal
Playwright project, so `dagger check` exercises discovery, version derivation,
service wiring, and the localhost proxy end to end.
