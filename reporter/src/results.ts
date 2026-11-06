/**
 * Playwright reporter that records what a run did, one JSON object per line,
 * for the module's indexer to attribute to test-file checks.
 *
 * Lines are written as events happen, so a run that crashes still leaves
 * everything up to the crash:
 *
 *   {"type":"plan","files":{"/app/x.spec.ts":2}}   tests Playwright will run, per file
 *   {"type":"begin","id":"…","file":"…"}           a test's first attempt started
 *   {"type":"test","id":"…","file":"…","title":"…","outcome":"…","status":"…","errors":[…]}
 *   {"type":"error","file":"…","message":"…"}      an error outside a test (file is optional)
 *   {"type":"end","status":"passed"}               the run finished
 *
 * A test's last "test" line holds its final outcome (expected, unexpected,
 * flaky or skipped). Error messages are capped, so the file stays small
 * whatever the tests print. The path comes from DAGGER_PLAYWRIGHT_RESULTS;
 * without it the reporter does nothing.
 */

import * as fs from "node:fs";
import type {
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from "@playwright/test/reporter";

// Per error message, and errors per test.
const MESSAGE_LIMIT = 4 << 10;
const ERRORS_PER_TEST = 4;

function message(error: TestError): string {
  const text = error.message ?? error.value ?? "unknown error";
  const where = error.location ? `${error.location.file}:${error.location.line}\n` : "";
  const body =
    text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}\n[message truncated]` : text;
  return where + body;
}

class DaggerResultsReporter implements Reporter {
  private fd: number | undefined;

  constructor() {
    const path = process.env.DAGGER_PLAYWRIGHT_RESULTS;
    if (path) {
      try {
        this.fd = fs.openSync(path, "w");
      } catch {
        this.fd = undefined;
      }
    }
  }

  printsToStdio(): boolean {
    return false;
  }

  private write(line: object): void {
    if (this.fd === undefined) {
      return;
    }
    try {
      fs.writeSync(this.fd, `${JSON.stringify(line)}\n`);
    } catch {
      // Never let the record affect the run.
    }
  }

  onBegin(_config: unknown, suite: Suite): void {
    const files: Record<string, number> = {};
    for (const test of suite.allTests()) {
      files[test.location.file] = (files[test.location.file] ?? 0) + 1;
    }
    this.write({ type: "plan", files });
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    if (result.retry === 0) {
      this.write({ type: "begin", id: test.id, file: test.location.file });
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.write({
      type: "test",
      id: test.id,
      file: test.location.file,
      title: test
        .titlePath()
        .filter((part) => part !== "")
        .join(" › "),
      outcome: test.outcome(),
      status: result.status,
      errors: result.errors.slice(0, ERRORS_PER_TEST).map(message),
    });
  }

  onError(error: TestError): void {
    this.write({ type: "error", file: error.location?.file ?? "", message: message(error) });
  }

  onEnd(result: FullResult): void {
    this.write({ type: "end", status: result.status });
  }

  async onExit(): Promise<void> {
    if (this.fd !== undefined) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Already closed.
      }
      this.fd = undefined;
    }
  }
}

// module.exports = the class, so Playwright finds it whether it requires the
// file or imports it from an ES module project.
export = DaggerResultsReporter;
