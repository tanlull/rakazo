import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeSignInsProgram } from "./desktop-runtime.js";

const python = spawnSync("python3", ["--version"]).status === 0;

// The columns that identify a cookie in Chromium, plus the ones the merge compares.
const SCHEMA = `CREATE TABLE cookies (creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT,
  name TEXT, value TEXT, path TEXT, source_scheme INTEGER, source_port INTEGER,
  last_update_utc INTEGER,
  UNIQUE (host_key, top_frame_site_key, name, path, source_scheme, source_port))`;

type Row = [host: string, name: string, value: string, updated: number];

function py(script: string, ...args: string[]) {
  const run = spawnSync("python3", ["-c", script, ...args], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout;
}

function writeCookies(file: string, rows: Row[]) {
  mkdirSync(path.dirname(file), { recursive: true });
  py(
    `import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute(sys.argv[2])
for host, name, value, updated in json.loads(sys.argv[3]):
    db.execute("INSERT INTO cookies VALUES (?, ?, '', ?, ?, '/', 2, 443, ?)",
               (updated, host, name, value, updated))
db.commit()`,
    file,
    SCHEMA,
    JSON.stringify(rows),
  );
}

function readCookies(file: string): string[] {
  return JSON.parse(
    py(
      `import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
print(json.dumps([h + " " + n + "=" + v for h, n, v in
  db.execute("SELECT host_key, name, value FROM cookies ORDER BY host_key, name")]))`,
      file,
    ),
  );
}

describe.skipIf(!python)("sharing sign-ins between a computer's browsers", () => {
  let root: string;
  const cookies = (bot: string) => path.join(root, `chromium-bot-${bot}`, "Default", "Cookies");
  const merge = (bot: string) =>
    py(mergeSignInsProgram(), path.join(root, `chromium-bot-${bot}`), root);

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("gives a new browser the sign-ins another bot made", () => {
    root = mkdtempSync(path.join(tmpdir(), "sign-ins-"));
    writeCookies(cookies("chief"), [[".google.com", "SID", "chief-session", 10]]);
    merge("mail");
    expect(readCookies(cookies("mail"))).toEqual([".google.com SID=chief-session"]);
  });

  it("keeps the newer cookie and the browser's own sign-ins", () => {
    root = mkdtempSync(path.join(tmpdir(), "sign-ins-"));
    writeCookies(cookies("chief"), [
      [".google.com", "SID", "new-session", 20],
      [".example.com", "old", "stale", 1],
    ]);
    writeCookies(cookies("mail"), [
      [".google.com", "SID", "old-session", 10],
      [".example.com", "old", "kept", 5],
      [".shop.test", "cart", "mine", 7],
    ]);
    merge("mail");
    expect(readCookies(cookies("mail"))).toEqual([
      ".example.com old=kept",
      ".google.com SID=new-session",
      ".shop.test cart=mine",
    ]);
  });

  it("does nothing when no other bot has a browser here", () => {
    root = mkdtempSync(path.join(tmpdir(), "sign-ins-"));
    writeCookies(cookies("mail"), [[".shop.test", "cart", "mine", 7]]);
    merge("mail");
    expect(readCookies(cookies("mail"))).toEqual([".shop.test cart=mine"]);
  });
});
