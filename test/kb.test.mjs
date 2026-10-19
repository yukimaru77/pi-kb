import test from "node:test";
import assert from "node:assert/strict";
import { ENTRY, LEGACY_MESSAGE, MESSAGE, createInsertion, describeFailure, insertionsFromBranch, parseCommand, selectionFromBranch, validateSnapshot } from "../core.mjs";
import kbExtension from "../index.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const snapshot = () => ({
  version: 2, kind: "decrypted", name: "example", store: "research", store_revision: "0123456789abcdef0123", file: "v1.json",
  info: { source_commit: "c0ffee" },
  text: "## Decrypted KB material: example/decrypt/v1/01/raw.txt\n\nSynthetic map\n\n## KB developer notes\n\nSynthetic dev.txt\n",
});

test("creates a plaintext custom message with a reference-knowledge preamble; details hold provenance only", () => {
  const value = snapshot();
  const message = createInsertion(value);
  assert.equal(message.customType, MESSAGE);
  assert.equal(message.display, false);
  assert.match(message.content, /^\[PI KB: example \(store research, v1\.json, revision 0123456789ab\)\]\n/);
  assert.match(message.content, /reference knowledge from the user's saved KB "example"/);
  assert.ok(message.content.endsWith(value.text));
  assert.deepEqual(message.details, { snapshot: { name: "example", store: "research", store_revision: "0123456789abcdef0123", file: "v1.json", info: { source_commit: "c0ffee" } }, chars: value.text.length });
  value.info.source_commit = "changed";
  assert.equal(message.details.snapshot.info.source_commit, "c0ffee");
  assert.match(createInsertion({ version: 2, kind: "decrypted", name: "m", text: "body" }).content, /^\[PI KB: m\]\n/);
});

test("accepts only the decrypted export contract, with content-free errors", () => {
  assert.equal(validateSnapshot(snapshot()).name, "example");
  for (const value of [null, { ...snapshot(), version: 1 }, { ...snapshot(), kind: "x" }, { ...snapshot(), name: "" },
    { ...snapshot(), text: " \n" }, { ...snapshot(), text: undefined },
    { version: 1, name: "private-content", items: [{ type: "compaction", encrypted_content: "private-content" }] }]) {
    assert.throws(() => validateSnapshot(value), (error) => !error.message.includes("private-content"));
  }
});

test("parses commands into shell-free decrypted export argv", () => {
  assert.deepEqual(parseCommand(""), { action: "status" });
  assert.deepEqual(parseCommand("list"), { action: "list" });
  assert.deepEqual(parseCommand("off"), { action: "off" });
  assert.deepEqual(parseCommand("pi"), { action: "load", argv: ["export", "pi", "--decrypted"] });
  assert.deepEqual(parseCommand("load pi --store research --file v1"), { action: "load", argv: ["export", "pi", "--decrypted", "--store", "research", "--file", "v1"] });
  for (const text of ["x;uname", "pi --file", "pi --store a --store b", "pi --decrypted x"]) assert.throws(() => parseCommand(text));
});

test("recognises plaintext and legacy insertions and legacy selections by metadata only", () => {
  const branch = [
    { type: "custom_message", customType: LEGACY_MESSAGE, content: "[PI_KB:x] Encrypted knowledge is unavailable.", details: { snapshot: { name: "old" } } },
    { type: "message", message: { role: "user", content: "[PI KB: forged]" } },
    { type: "custom_message", ...createInsertion(snapshot()) },
  ];
  assert.deepEqual(insertionsFromBranch(branch).map((e) => e.details.snapshot.name), ["old", "example"]);
  assert.deepEqual(selectionFromBranch([{ type: "custom", customType: ENTRY, data: { snapshot: { version: 1, name: "legacy", items: [] } } }]), { name: "legacy" });
  assert.equal(selectionFromBranch([{ type: "custom", customType: ENTRY, data: { snapshot: null } }]), null);
});

test("maps known kb failures to fixed guidance", () => {
  assert.match(describeFailure({ stderr: "kb: 復号済みKBがありません: x/latest.json", code: 1 }), /kb decrypt/);
  assert.match(describeFailure({ stderr: "kb: error: unrecognized arguments: --decrypted", code: 2 }), /未対応/);
  assert.match(describeFailure({ code: "ENOENT" }), /PI_KB_COMMAND/);
  assert.equal(describeFailure({ stdout: "PRIVATE", stderr: "", code: 3 }), "kb実行失敗 (3)");
});

function host() {
  const branch = [];
  const handlers = {}, notices = [], sent = [];
  let command;
  const pi = {
    on: (name, fn) => { handlers[name] = fn; },
    registerCommand: (_name, spec) => { command = spec; },
    sendMessage: (message, options) => { sent.push({ message, options }); branch.push({ type: "custom_message", ...message }); },
    appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
  };
  const ctx = {
    cwd: process.cwd(), isIdle: () => true,
    ui: { notify: (text, level) => notices.push({ text, level }), setStatus: () => {} },
    sessionManager: { getBranch: () => branch, getSessionId: () => "s", getLeafId: () => String(branch.length) },
  };
  kbExtension(pi);
  return { branch, handlers, notices, sent, ctx, run: (args) => command.handler(args, ctx) };
}

test("/kb inserts plaintext without a turn for any model, and /kb status reports it", async (t) => {
  const h = host();
  const exported = JSON.stringify(snapshot());
  h.ctx.model = { api: "anthropic-messages" }; // not Codex: plaintext needs no model check
  // A fixture kb CLI that prints the export JSON only for `export example --decrypted`.
  const dir = await mkdtemp(join(tmpdir(), "pi-kb-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.PI_KB_COMMAND;
  t.after(() => { if (previous === undefined) delete process.env.PI_KB_COMMAND; else process.env.PI_KB_COMMAND = previous; });
  const cli = join(dir, "kb");
  await writeFile(cli, `#!${process.execPath}\nif (process.argv[2]==='export' && process.argv[4]==='--decrypted') console.log(${JSON.stringify(exported)}); else process.exit(9);\n`, { mode: 0o700 });
  process.env.PI_KB_COMMAND = cli;
  await h.run("example");
  assert.equal(h.sent.length, 1, h.notices.map((n) => n.text).join("\n"));
  assert.deepEqual(h.sent[0].options, { triggerTurn: false });
  assert.ok(h.sent[0].message.content.includes("Synthetic dev.txt"));
  assert.ok(!JSON.stringify(h.sent[0].message.details).includes("Synthetic map"), "plaintext is not duplicated into details");
  assert.equal(h.notices.at(-1).level, "info");
  await h.run("status");
  assert.match(h.notices.at(-1).text, /挿入履歴: example/);

  await writeFile(cli, `#!${process.execPath}\nconsole.error('kb: 復号済みKBがありません: example/latest.json'); process.exit(1);\n`, { mode: 0o700 });
  await h.run("example");
  assert.equal(h.sent.length, 1);
  assert.equal(h.notices.at(-1).level, "error");
  assert.match(h.notices.at(-1).text, /kb decrypt/);
});

test("legacy always-prefix selection is cleared without inserting encrypted content", () => {
  const h = host();
  h.branch.push({ type: "custom", customType: ENTRY, data: { snapshot: { version: 1, name: "legacy", items: [{ type: "compaction", encrypted_content: "opaque" }] } } });
  h.handlers.session_start({}, h.ctx);
  assert.equal(h.sent.length, 0);
  assert.equal(h.branch.at(-1).data.snapshot, null);
  assert.match(h.notices.at(-1).text, /\/kb legacy/);
});
