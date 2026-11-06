/**
 * Reads the records of one project's shared Playwright run and writes one
 * bounded result per selected test file: an empty file when it passed, else
 * the failure its check raises.
 *
 *   bun indexer.ts <selection.json> <output dir>
 *
 * selection.json holds the selected files, in the order their checks rank
 * them, and the runs (containers) that ran them:
 *
 *   {"config": "web/playwright.config.ts",
 *    "files": [{"key": "tests/a.spec.ts", "path": "/app/web/tests/a.spec.ts"}],
 *    "runs": [{"dir": "/in/0", "label": "shard 1/2", "keys": ["tests/a.spec.ts"]}]}
 *
 * A run's directory holds results.jsonl (written by results.ts), stdout,
 * stderr and exit. The result for files[i] is written to <output dir>/<i>, so
 * file names never become paths.
 *
 * Run with bun (or a Node that strips types); it uses only the standard
 * library, so it needs no install.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// Last bytes kept of each output stream, and the most a result may hold.
const TAIL_LIMIT = 32 << 10;
const RESULT_LIMIT = 96 << 10;

type Selected = { key: string; path: string };
type RunSpec = { dir: string; label: string; keys: string[] };
type Selection = { config: string; files: Selected[]; runs: RunSpec[] };

type TestRecord = {
  file: string;
  title: string;
  begun: boolean;
  ended: boolean;
  outcome: string;
  status: string;
  errors: string[];
};

type Run = {
  spec: RunSpec;
  exit: number | null;
  report: boolean;
  ended: string | null;
  plan: Map<string, number>;
  tests: Map<string, TestRecord>;
  errors: { file: string; message: string }[];
  output: string;
};

// --max-failures reports where it stopped as an error of its own; the
// failures that stopped it are reported on their files.
const stoppedEarly = /^Testing stopped early after \d+ maximum allowed failures/;

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

function clean(text: string): string {
  return text.replace(ansi, "");
}

// The last TAIL_LIMIT bytes of a file, read without loading the rest.
function tail(file: string): string {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TAIL_LIMIT);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const text = clean(buffer.toString("utf8"));
    return size > TAIL_LIMIT ? `[earlier output omitted]\n${text}` : text;
  } finally {
    fs.closeSync(fd);
  }
}

async function readRun(spec: RunSpec): Promise<Run> {
  const run: Run = {
    spec,
    exit: null,
    report: false,
    ended: null,
    plan: new Map(),
    tests: new Map(),
    errors: [],
    output: "",
  };
  try {
    const code = Number.parseInt(fs.readFileSync(path.join(spec.dir, "exit"), "utf8").trim(), 10);
    run.exit = Number.isNaN(code) ? null : code;
  } catch {
    run.exit = null;
  }
  const out = tail(path.join(spec.dir, "stdout")).trim();
  const err = tail(path.join(spec.dir, "stderr")).trim();
  run.output = [out, err].filter((s) => s !== "").join("\n");
  const report = path.join(spec.dir, "results.jsonl");
  if (!fs.existsSync(report)) {
    return run;
  }
  run.report = true;
  const lines = readline.createInterface({
    input: fs.createReadStream(report),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      // A line cut short by a crash.
      continue;
    }
    const file = typeof event.file === "string" ? event.file : "";
    switch (event.type) {
      case "plan":
        for (const [f, n] of Object.entries((event.files ?? {}) as Record<string, number>)) {
          run.plan.set(f, (run.plan.get(f) ?? 0) + n);
        }
        break;
      case "begin": {
        const t = record(run, String(event.id), file);
        t.begun = true;
        break;
      }
      case "test": {
        const t = record(run, String(event.id), file);
        t.begun = true;
        t.ended = true;
        t.title = String(event.title ?? "");
        t.outcome = String(event.outcome ?? "");
        t.status = String(event.status ?? "");
        t.errors = Array.isArray(event.errors) ? event.errors.map((e) => clean(String(e))) : [];
        break;
      }
      case "error":
        run.errors.push({ file, message: clean(String(event.message ?? "")) });
        break;
      case "end":
        run.ended = String(event.status ?? "");
        break;
    }
  }
  return run;
}

function record(run: Run, id: string, file: string): TestRecord {
  let t = run.tests.get(id);
  if (!t) {
    t = { file, title: "", begun: false, ended: false, outcome: "", status: "", errors: [] };
    run.tests.set(id, t);
  }
  return t;
}

function failed(t: TestRecord): boolean {
  return t.ended && t.outcome === "unexpected";
}

function describe(t: TestRecord): string {
  const errors = t.errors.length > 0 ? `\n${t.errors.join("\n")}` : "";
  return `✘ ${t.title} (${t.status})${errors}`;
}

function exitText(run: Run): string {
  return run.exit === null ? "no exit status" : `exit ${run.exit}`;
}

function withOutput(header: string, run: Run, shown = ""): string {
  if (run.output === "" || (shown !== "" && run.output.includes(shown.trim()))) {
    return header;
  }
  return `${header}\n${run.output}`;
}

function cap(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= RESULT_LIMIT) {
    return text;
  }
  return `${Buffer.from(text, "utf8").subarray(0, RESULT_LIMIT).toString("utf8")}\n[remaining diagnostics omitted]\n`;
}

async function main(): Promise<void> {
  const [selectionPath, outDir] = process.argv.slice(2);
  if (!selectionPath || !outDir) {
    throw new Error("usage: indexer <selection.json> <output dir>");
  }
  const selection = JSON.parse(fs.readFileSync(selectionPath, "utf8")) as Selection;
  const rankOf = new Map<string, number>();
  selection.files.forEach((f, i) => {
    if (rankOf.has(f.key)) {
      throw new Error(`duplicate selected file ${f.key}`);
    }
    rankOf.set(f.key, i);
  });
  // The selected file a test file (an absolute path) belongs to.
  const rankOfPath = new Map<string, number>();
  selection.files.forEach((f, i) => {
    rankOfPath.set(f.path, i);
  });
  const owner = (file: string): number | undefined => rankOfPath.get(file);
  // Playwright stops before reporting when it can't load the config.
  const config =
    selection.config === "" ? "no playwright.config found" : `config ${selection.config}`;

  type Verdict = {
    covered: boolean;
    // Whether a covering run left a report to judge the file by.
    reported: boolean;
    global: string[];
    own: string[];
    planned: number;
    unfinished: string[];
    missing: string[];
    // Selected files whose load errors stopped a covering run before it
    // planned any test: Playwright runs nothing when a file fails to load.
    aborted: string[];
  };
  const verdicts: Verdict[] = selection.files.map(() => ({
    covered: false,
    reported: false,
    global: [],
    own: [],
    planned: 0,
    unfinished: [],
    missing: [],
    aborted: [],
  }));

  // Failures of the runs themselves, for a caller with no files to blame.
  const runFailures: string[] = [];
  for (const spec of selection.runs) {
    const run = await readRun(spec);
    const ranks = spec.keys.map((k) => {
      const r = rankOf.get(k);
      if (r === undefined) {
        throw new Error(`run ${spec.label} covers unselected file ${k}`);
      }
      return r;
    });

    // Failures in this run, by the selected file they belong to.
    const own = new Map<number, string[]>();
    const outside: string[] = [];
    const general: string[] = [];
    const addOwn = (rank: number, text: string) => {
      const list = own.get(rank) ?? [];
      list.push(text);
      own.set(rank, list);
    };
    for (const t of run.tests.values()) {
      if (!failed(t)) {
        continue;
      }
      const rank = owner(t.file);
      if (rank === undefined) {
        outside.push(`${t.file}:\n${describe(t)}`);
      } else {
        addOwn(rank, describe(t));
      }
    }
    for (const e of run.errors) {
      const rank = e.file === "" ? undefined : owner(e.file);
      if (rank !== undefined) {
        addOwn(rank, e.message);
      } else if (e.file !== "") {
        outside.push(`${e.file}:\n${e.message}`);
      } else if (!stoppedEarly.test(e.message)) {
        general.push(e.message);
      }
    }

    // A failure that belongs to no selected file fails every file the run
    // covers, and so does a failed run with nothing to attribute.
    const exit = exitText(run);
    let global = "";
    if (outside.length > 0) {
      global = withOutput(
        `failures outside the selected test files (${spec.label}, ${exit}):\n${outside.join("\n")}`,
        run,
      );
    } else if (general.length > 0) {
      global = withOutput(
        `Playwright failed outside any test (${spec.label}, ${exit}):\n${general.join("\n")}`,
        run,
        general[0],
      );
    } else if (!run.report && run.exit !== 0) {
      global = withOutput(
        `playwright test failed (${spec.label}, ${exit}) before reporting any test; ${config}`,
        run,
      );
    } else if (run.exit !== 0 && own.size === 0) {
      global = withOutput(
        `playwright test failed (${spec.label}, ${exit}) with no failing test`,
        run,
      );
    }

    if (global !== "") {
      runFailures.push(global);
    }
    for (const rank of ranks) {
      const v = verdicts[rank];
      v.covered = true;
      if (global !== "") {
        v.global.push(global);
        continue;
      }
      if (!run.report) {
        // The results reporter never ran (a --reporter in args replaces it)
        // and the run passed: there is nothing to attribute.
        continue;
      }
      v.reported = true;
      v.own.push(...(own.get(rank) ?? []));
      if (run.plan.size === 0 && !own.has(rank)) {
        v.aborted.push(...[...own.keys()].map((r) => selection.files[r].key));
      }
      let planned = 0;
      for (const [file, n] of run.plan) {
        if (owner(file) === rank) {
          planned += n;
        }
      }
      let seen = 0;
      for (const t of run.tests.values()) {
        if (owner(t.file) !== rank) {
          continue;
        }
        seen++;
        if (!t.ended) {
          v.unfinished.push(t.title || t.file);
        }
      }
      v.planned += planned;
      // Tests that never started after a failure attributed to a selected
      // file (--max-failures) are not blamed for it.
      if (planned > seen && own.size === 0) {
        v.missing.push(
          withOutput(
            `${planned - seen} planned test(s) never started (${spec.label}, ${exit})`,
            run,
          ),
        );
      }
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "all"), cap(runFailures.join("\n")));
  selection.files.forEach((_file, i) => {
    const v = verdicts[i];
    let result = "";
    if (!v.covered) {
      result = "no run covered this file";
    } else if (v.global.length > 0) {
      result = [...new Set(v.global)].join("\n");
    } else if (v.own.length > 0) {
      result = `${v.own.length === 1 ? "1 failure" : `${v.own.length} failures`}:\n${v.own.join("\n")}`;
    } else if (v.unfinished.length > 0) {
      result = `tests did not finish: ${v.unfinished.join(", ")}`;
    } else if (v.missing.length > 0) {
      result = v.missing.join("\n");
    } else if (v.aborted.length > 0) {
      result = `did not run: Playwright ran no test because ${[...new Set(v.aborted)].join(", ")} failed to load`;
    } else if (v.reported && v.planned === 0) {
      result = "did not run: Playwright passed without running any test from this file";
    }
    fs.writeFileSync(path.join(outDir, String(i)), cap(result));
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
