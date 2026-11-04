import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCOPE_NOTE, exportDecrypted, findConfig, listKbs } from "../store.mjs";
import kbExtension, { AUTOLOAD_FLAG } from "../index.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

/** A store repository like pepabo-kb-store: NAME/info.json, dev.txt and decrypted plaintext per blob. */
function makeStore() {
  const root = mkdtempSync(join(tmpdir(), "pi-kb-store-"));
  const work = join(root, "work");
  const write = (path, text) => { mkdirSync(join(work, path, ".."), { recursive: true }); writeFileSync(join(work, path), text); };
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  write("octane/info.json", JSON.stringify({ source_commit: "abcdef0123456789", branch: "main", windows: [{ name: "Billing" }, { name: "Keys" }] }));
  write("octane/latest.json", "[]");
  write("octane/dev.txt", "Use the KB first.\n");
  write("octane/decrypt/latest/01-a/raw.txt", "RAW A with conversation\n");
  write("octane/decrypt/latest/01-a/knowledge.txt", "KNOWLEDGE A\n");
  write("octane/decrypt/latest/02-b/raw.txt", "RAW B\n");
  write("other/info.json", JSON.stringify({ branch: "main" }));
  git(work, "add", "-A");
  git(work, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "store");
  const bare = join(root, "store.git");
  execFileSync("git", ["clone", "-q", "--bare", work, bare]);
  return { root, url: bare };
}

test("project .pi/kb.json wins over the agent directory's", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-kb-cwd-")), dir = mkdtempSync(join(tmpdir(), "pi-kb-agent-"));
  writeFileSync(join(dir, "kb.json"), JSON.stringify({ stores: [{ name: "user", url: "u" }] }));
  assert.equal(findConfig(cwd, dir).stores[0].name, "user");
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "kb.json"), JSON.stringify({ stores: [{ name: "project", url: "p" }] }));
  assert.equal(findConfig(cwd, dir).stores[0].name, "project");
  assert.equal(findConfig(mkdtempSync(join(tmpdir(), "pi-kb-none-")), mkdtempSync(join(tmpdir(), "pi-kb-none-"))), null);
  writeFileSync(join(cwd, ".pi", "kb.json"), JSON.stringify({ stores: [] }));
  assert.throws(() => findConfig(cwd, dir), /stores/);
});

test("reads the decrypted KB from the store with git, like kb export --decrypted", async () => {
  const { root, url } = makeStore();
  const config = { path: "kb.json", stores: [{ name: "team", url }], cacheDir: join(root, "cache") };
  const snapshot = await exportDecrypted(config, "octane");
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.kind, "decrypted");
  assert.equal(snapshot.store, "team");
  assert.equal(snapshot.file, "latest.json");
  assert.equal(snapshot.info.source_commit, "abcdef0123456789");
  assert.equal(snapshot.text, [
    `## KB section 1/2: Billing\n> ${SCOPE_NOTE}\n\nKNOWLEDGE A\n\n## End of KB section 1/2`,
    `## KB section 2/2: Keys\n> ${SCOPE_NOTE}\n\nRAW B\n\n## End of KB section 2/2`,
    "## KB developer notes\n\nUse the KB first.",
  ].join("\n\n") + "\n");
  await assert.rejects(exportDecrypted(config, "missing"), /ありません/);
  await assert.rejects(exportDecrypted(config, "other"), /復号済みKBがありません/);
  await assert.rejects(exportDecrypted(config, "octane", { store: "nope" }), /nope/);
  assert.match(await listKbs(config), /^octane\tteam\tabcdef012345\tmain\t復号済み\nother\tteam\t未作成\tmain\t未復号$/);
});

test("pi --kb NAME loads the KB natively without the kb command", async (t) => {
  const { root, url } = makeStore();
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "kb.json"), JSON.stringify({ stores: [{ name: "team", url }], cacheDir: join(root, "cache") }));
  const previous = process.env.PI_KB_COMMAND;
  process.env.PI_KB_COMMAND = join(root, "no-such-kb");
  t.after(() => { if (previous === undefined) delete process.env.PI_KB_COMMAND; else process.env.PI_KB_COMMAND = previous; });
  const handlers = {}, flags = {}, sent = [], notices = [], status = {};
  let command;
  const branch = [];
  kbExtension({
    on: (name, fn) => { handlers[name] = fn; },
    registerCommand: (_n, spec) => { command = spec; },
    registerFlag: (name, spec) => { flags[name] = spec; },
    getFlag: (name) => (name === AUTOLOAD_FLAG ? "octane" : undefined),
    sendMessage: (message, options) => { sent.push({ message, options }); branch.push({ type: "custom_message", ...message }); },
    appendEntry: () => {},
  });
  assert.equal(flags[AUTOLOAD_FLAG].type, "string");
  const ctx = {
    cwd, isIdle: () => true,
    ui: { notify: (text, level) => notices.push({ text, level }), setStatus: (k, v) => { status[k] = v; } },
    sessionManager: { getBranch: () => branch, getSessionId: () => "s", getLeafId: () => String(branch.length) },
  };
  await handlers.session_start({ reason: "startup" }, ctx);
  assert.equal(sent.length, 1, notices.map((n) => n.text).join("\n"));
  assert.match(sent[0].message.content, /KNOWLEDGE A/);
  assert.equal(status["pi-kb"], "📚 KB: octane");
  await command.handler("list", ctx);
  assert.match(notices.at(-1).text, /^octane\tteam/);
});
