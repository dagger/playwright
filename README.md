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
| `base`         | The prepared test container (project mounted, deps installed, service bound). |
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

- **`sourcePath`** (default: discover): workspace path of the Playwright
  project. By default the module finds the directory containing
  `playwright.config.*`; setting this is required when the workspace holds
  more than one Playwright project.
- **`service`**: module reference (`"module:function"`) of the service under
  test.
- **`serviceHostname`** (default `frontend`): hostname the service is bound as.
- **`baseImageAddress`** (default: derive): the image tests run in. By default
  it is derived from your project's `@playwright/test` version
  (`mcr.microsoft.com/playwright:v<version>-noble`), so browsers always match
  your Playwright version. Derivation reads the *declared* version, so pin it
  exactly (or commit a lockfile) — a floating range like `^1.58.2` can install
  a newer Playwright than the derived image's browsers.
- **`baseCtr`**: a full `Container` override, also wireable
  (`baseCtr = "base-images:chromium"`). `npx playwright` must work in it after
  dependency install.
- **`packageManager`** (default `npm`): how project dependencies are installed
  (`npm`, `yarn`, `pnpm`, `bun`). yarn and pnpm are enabled via corepack.
- **`localhostProxy`** (default `false`): see secure contexts above.
- **`args`** (default `[]`): extra arguments for every `playwright test`
  invocation, e.g. `["--project", "chromium"]`.

## Sharding

```sh
dagger api call playwright test --shards=4
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
