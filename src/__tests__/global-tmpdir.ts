/**
 * Give each test run its own TMPDIR and delete it afterwards. Many tests
 * create mkdtemp databases they never remove; without this a few dozen runs
 * fill a tmpfs /tmp.
 */
import fs from "fs";
import os from "os";
import path from "path";

export default function setup(): () => void {
  const base = process.env.AUTOMATON_TEST_TMP_PARENT || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, "automaton-vitest-"));
  process.env.TMPDIR = dir;
  return () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
