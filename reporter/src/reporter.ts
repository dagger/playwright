/**
 * Playwright reporter that sends test telemetry to Dagger as OpenTelemetry
 * spans and logs.
 *
 * Playwright runs tests in worker processes and reports them to the runner
 * process, where reporters live, so everything here comes from reporter
 * events: no Playwright internals are patched. Spans form a tree of project
 * (when named), file, describe blocks, tests and the steps inside each test
 * (hooks, fixtures, page actions, expects and test.step calls). Each test's
 * stdout and stderr become logs on its span.
 *
 * A test has one span carrying its final outcome, so Dagger counts it once.
 * Its first run's steps and output are on that span; each retry is a child
 * span holding its own, like the Run and Retry tabs of Playwright's report.
 *
 * Spans are parented to the TRACEPARENT Dagger sets on the exec, and the SDK
 * only starts when Dagger's OTEL_* variables are present, so the reporter is
 * a no-op anywhere else.
 */

import { OtelSDK } from "@dagger.io/telemetry";
import {
  type Attributes,
  type Context,
  context,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

const ATTR_UI_BOUNDARY = "dagger.io/ui.boundary";
const STDIO_STREAM_ATTR = "stdio.stream";
const STDIO_STREAM_STDOUT = 1;
const STDIO_STREAM_STDERR = 2;

// OpenTelemetry test semantic conventions. They are still incubating, so the
// names are copied here rather than imported from the incubating entry point.
const ATTR_TEST_CASE_NAME = "test.case.name";
const ATTR_TEST_CASE_RESULT_STATUS = "test.case.result.status";
const ATTR_TEST_SUITE_NAME = "test.suite.name";
const ATTR_TEST_SUITE_RUN_STATUS = "test.suite.run.status";

const ATTR_OUTCOME = "playwright.test.outcome";
const ATTR_RETRY = "playwright.test.retry";
const ATTR_STEP_CATEGORY = "playwright.step.category";

type Telemetry = {
  span: Span;
  ctx: Context;
};

type Attempt = Telemetry & {
  test: TestCase;
  // Whether the attempt has a span of its own: a retry, rather than the
  // first run, which shares the test's.
  own: boolean;
  // Steps of this attempt that have begun and not yet ended.
  steps: Map<TestStep, Telemetry>;
};

type SuiteTelemetry = Telemetry & {
  // Latest end time of the tests finished so far, in ms since the epoch.
  end: number;
};

type SuiteState = {
  // Tests under the suite that have not finished.
  pending: number;
  // Whether a finished test under the suite failed.
  failed: boolean;
  // Whether a finished test under the suite ran rather than being skipped.
  ran: boolean;
  telemetry?: SuiteTelemetry;
};

type ConsoleStream = "stderr" | "stdout";

/**
 * The kind of a suite. Suite.type only exists from Playwright 1.44, but the
 * tree has always been root, then projects, then files, then describes.
 */
function suiteKind(suite: Suite): Suite["type"] {
  if (suite.type) return suite.type;
  if (!suite.parent) return "root";
  if (!suite.parent.parent) return "project";
  if (!suite.parent.parent.parent) return "file";
  return "describe";
}

/**
 * Whether a suite gets a span: files and describes always, projects only
 * when they have a name. A config without projects still has one, unnamed.
 */
function hasSpan(suite: Suite): boolean {
  const kind = suiteKind(suite);
  return kind === "file" || kind === "describe" || (kind === "project" && suite.title !== "");
}

/**
 * The suites with spans that enclose a test or suite, innermost first.
 */
function spannedAncestors(suite: Suite | undefined): Suite[] {
  const suites: Suite[] = [];
  for (let s = suite; s; s = s.parent) {
    if (hasSpan(s)) suites.push(s);
  }
  return suites;
}

/**
 * A name joined from a title path, without the empty titles of the root and
 * of an unnamed project: "chromium::login.spec.ts::form::submits".
 */
function joinTitles(titles: string[]): string {
  return titles.filter((t) => t !== "").join("::");
}

function endTime(start: Date, duration: number): Date {
  return duration >= 0 ? new Date(start.getTime() + duration) : new Date();
}

/**
 * Whether Playwright will run the test again after this attempt: it retries
 * unexpected failures while retries remain.
 */
function willRetry(test: TestCase, result: TestResult): boolean {
  return (
    result.status !== "skipped" &&
    result.status !== "interrupted" &&
    result.status !== test.expectedStatus &&
    result.retry < test.retries
  );
}

/**
 * Whether an attempt went as expected: passed, skipped, or failed in a test
 * marked test.fail().
 */
function attemptOk(test: TestCase, result: TestResult): boolean {
  return result.status === "skipped" || result.status === test.expectedStatus;
}

function failureMessage(test: TestCase, result: TestResult): string {
  switch (result.status) {
    case "timedOut":
      return "test timed out";
    case "interrupted":
      return "test interrupted";
    case "passed":
      return test.expectedStatus === "failed" ? "expected to fail, but passed" : "test failed";
    default:
      return "test failed";
  }
}

function errorText(error: TestError): string {
  const text = error.stack ?? error.message ?? error.value ?? "unknown error";
  return error.snippet ? `${text}\n\n${error.snippet}` : text;
}

function recordError(span: Span, error: TestError): void {
  span.recordException({
    name: "Error",
    message: error.message ?? error.value ?? "unknown error",
    stack: error.stack,
  });
}

class DaggerReporter implements Reporter {
  private readonly sdk = new OtelSDK();
  private readonly tracer = trace.getTracer("dagger.io/playwright");
  private readonly logger = logs.getLogger("dagger.io/playwright");

  private readonly suites = new Map<Suite, SuiteState>();
  private readonly tests = new Map<TestCase, Telemetry>();
  private readonly attempts = new Map<TestResult, Attempt>();

  printsToStdio(): boolean {
    return false;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.sdk.start();

    // Count the tests under each spanned suite, so its span ends when the
    // last of them finishes. The suite only holds the tests this run will
    // run, after filters and sharding.
    for (const test of suite.allTests()) {
      for (const s of spannedAncestors(test.parent)) {
        this.suiteState(s).pending++;
      }
    }
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    let telemetry = this.tests.get(test);
    if (!telemetry) {
      const parent = this.suiteContext(test.parent, result.startTime);
      const attributes: Attributes = {
        [ATTR_UI_BOUNDARY]: true,
        [ATTR_TEST_CASE_NAME]: joinTitles(test.titlePath()),
        [ATTR_TEST_SUITE_NAME]: joinTitles(test.parent.titlePath()),
      };
      const span = this.tracer.startSpan(
        test.title,
        { attributes, startTime: result.startTime },
        parent,
      );
      telemetry = { span, ctx: trace.setSpan(parent, span) };
      this.tests.set(test, telemetry);
    }

    if (result.retry === 0) {
      this.attempts.set(result, { ...telemetry, test, own: false, steps: new Map() });
      return;
    }
    const span = this.tracer.startSpan(
      `retry #${result.retry}`,
      { attributes: { [ATTR_RETRY]: result.retry }, startTime: result.startTime },
      telemetry.ctx,
    );
    const ctx = trace.setSpan(telemetry.ctx, span);
    this.attempts.set(result, { span, ctx, test, own: true, steps: new Map() });
  }

  onStepBegin(_test: TestCase, result: TestResult, step: TestStep): void {
    const attempt = this.attempts.get(result);
    if (!attempt) return;

    const parent = (step.parent && attempt.steps.get(step.parent)?.ctx) || attempt.ctx;
    const span = this.tracer.startSpan(
      step.title,
      { attributes: { [ATTR_STEP_CATEGORY]: step.category }, startTime: step.startTime },
      parent,
    );
    attempt.steps.set(step, { span, ctx: trace.setSpan(parent, span) });
  }

  onStepEnd(_test: TestCase, result: TestResult, step: TestStep): void {
    const attempt = this.attempts.get(result);
    const telemetry = attempt?.steps.get(step);
    if (!attempt || !telemetry) return;

    if (step.error) {
      recordError(telemetry.span, step.error);
      telemetry.span.setStatus({ code: SpanStatusCode.ERROR });
    }
    telemetry.span.end(endTime(step.startTime, step.duration));
    attempt.steps.delete(step);
  }

  onStdOut(
    chunk: string | Buffer,
    _test: TestCase | undefined,
    result: TestResult | undefined,
  ): void {
    this.emitStdio(result, "stdout", chunk.toString());
  }

  onStdErr(
    chunk: string | Buffer,
    _test: TestCase | undefined,
    result: TestResult | undefined,
  ): void {
    this.emitStdio(result, "stderr", chunk.toString());
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const attempt = this.attempts.get(result);
    if (attempt) {
      this.endAttempt(test, result, attempt);
    }
    if (willRetry(test, result)) return;

    const outcome = test.outcome();
    const status = outcome === "skipped" ? "skipped" : outcome === "unexpected" ? "fail" : "pass";
    this.tests.get(test)?.span.setAttribute(ATTR_OUTCOME, outcome);
    this.finishTest(
      test,
      status,
      endTime(result.startTime, result.duration),
      failureMessage(test, result),
    );
  }

  async onEnd(_result: FullResult): Promise<void> {
    // An interrupt, a crash or maxFailures can stop tests before onTestEnd,
    // or before a retry onTestEnd expected: end what is still open.
    for (const attempt of this.attempts.values()) {
      for (const step of attempt.steps.values()) {
        step.span.end();
      }
      if (attempt.own) {
        attempt.span.setStatus({ code: SpanStatusCode.ERROR, message: "attempt did not finish" });
        attempt.span.end();
      }
      this.finishTest(attempt.test, "fail", new Date(), "test did not finish");
    }
    this.attempts.clear();
    // Tests whose last attempt failed and was meant to be retried.
    for (const test of [...this.tests.keys()]) {
      const last = test.results[test.results.length - 1];
      const end = last ? endTime(last.startTime, last.duration) : new Date();
      this.finishTest(test, "fail", end, "test failed");
    }
    for (const state of this.suites.values()) {
      this.endSuite(state, state.pending > 0);
    }

    await this.sdk.shutdown();
  }

  private suiteState(suite: Suite): SuiteState {
    let state = this.suites.get(suite);
    if (!state) {
      state = { pending: 0, failed: false, ran: false };
      this.suites.set(suite, state);
    }
    return state;
  }

  /**
   * The context to start a span under for something in suite: the span of
   * the innermost spanned suite, started now if it is not yet, or the exec's
   * context when there is none.
   */
  private suiteContext(suite: Suite | undefined, startTime: Date): Context {
    if (!suite) return context.active();
    if (!hasSpan(suite)) return this.suiteContext(suite.parent, startTime);

    const state = this.suiteState(suite);
    if (!state.telemetry) {
      const parent = this.suiteContext(suite.parent, startTime);
      // No run status until the suite ends: Dagger keeps the highest-priority
      // status a span ever had, and in_progress outranks success. An open
      // span without one already shows as running.
      const attributes: Attributes = {
        [ATTR_UI_BOUNDARY]: true,
        [ATTR_TEST_SUITE_NAME]: joinTitles(suite.titlePath()),
      };
      const span = this.tracer.startSpan(suite.title, { attributes, startTime }, parent);
      state.telemetry = { span, ctx: trace.setSpan(parent, span), end: startTime.getTime() };
    }
    return state.telemetry.ctx;
  }

  private endAttempt(test: TestCase, result: TestResult, attempt: Attempt): void {
    // Playwright ends a test's steps before the test; this is a safeguard.
    for (const step of attempt.steps.values()) {
      step.span.end();
    }

    for (const error of result.errors) {
      recordError(attempt.span, error);
      this.emitLog(attempt.ctx, "stderr", `${errorText(error).trimEnd()}\n`);
    }

    if (attempt.own) {
      if (!attemptOk(test, result)) {
        attempt.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: failureMessage(test, result),
        });
      } else if (result.status !== "skipped") {
        attempt.span.setStatus({ code: SpanStatusCode.OK });
      }
      attempt.span.end(endTime(result.startTime, result.duration));
    }
    this.attempts.delete(result);
  }

  /**
   * End a test's span with its result status, failing it with message, and
   * count it as finished in its suites, ending those it was the last of.
   */
  private finishTest(
    test: TestCase,
    status: "pass" | "fail" | "skipped",
    end: Date,
    message: string,
  ): void {
    const telemetry = this.tests.get(test);
    if (telemetry) {
      telemetry.span.setAttribute(ATTR_TEST_CASE_RESULT_STATUS, status);
      if (status === "fail") {
        telemetry.span.setStatus({ code: SpanStatusCode.ERROR, message });
      } else if (status === "pass") {
        telemetry.span.setStatus({ code: SpanStatusCode.OK });
      }
      telemetry.span.end(end);
      this.tests.delete(test);
    }

    for (const s of spannedAncestors(test.parent)) {
      const state = this.suiteState(s);
      state.pending--;
      state.failed ||= status === "fail";
      state.ran ||= status !== "skipped";
      if (state.telemetry) {
        state.telemetry.end = Math.max(state.telemetry.end, end.getTime());
      }
      if (state.pending <= 0) {
        this.endSuite(state, false);
      }
    }
  }

  /**
   * End a suite's span, if it has one that is still open. aborted is true
   * when the run ended before all of the suite's tests finished.
   */
  private endSuite(state: SuiteState, aborted: boolean): void {
    const telemetry = state.telemetry;
    if (!telemetry) return;
    state.telemetry = undefined;

    let status: string;
    if (state.failed) {
      status = "failure";
      telemetry.span.setStatus({ code: SpanStatusCode.ERROR });
    } else if (aborted) {
      status = "aborted";
      telemetry.span.setStatus({ code: SpanStatusCode.ERROR, message: "run ended early" });
    } else if (!state.ran) {
      status = "skipped";
    } else {
      status = "success";
      telemetry.span.setStatus({ code: SpanStatusCode.OK });
    }
    telemetry.span.setAttribute(ATTR_TEST_SUITE_RUN_STATUS, status);
    telemetry.span.end(aborted ? new Date() : new Date(telemetry.end));
  }

  private emitStdio(result: TestResult | undefined, stream: ConsoleStream, body: string): void {
    // Output outside a test (global setup, the web server) is already in the
    // exec's own output.
    const attempt = result ? this.attempts.get(result) : undefined;
    if (attempt) {
      this.emitLog(attempt.ctx, stream, body);
    }
  }

  private emitLog(ctx: Context, stream: ConsoleStream, body: string): void {
    try {
      this.logger.emit({
        timestamp: Date.now(),
        observedTimestamp: Date.now(),
        severityNumber: stream === "stderr" ? SeverityNumber.ERROR : SeverityNumber.INFO,
        severityText: stream === "stderr" ? "ERROR" : "INFO",
        body,
        attributes: {
          [STDIO_STREAM_ATTR]: stream === "stderr" ? STDIO_STREAM_STDERR : STDIO_STREAM_STDOUT,
        },
        context: ctx,
      });
    } catch {
      // Do not let telemetry affect the test run.
    }
  }
}

// module.exports = the class, so Playwright finds it whether it requires the
// file or imports it from an ES module project.
export = DaggerReporter;
