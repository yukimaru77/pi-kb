import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Config file name, looked up in `<cwd>/.pi/` first and then in the Pi agent directory. */
export const CONFIG_NAME = "kb.json";
/** Same note kb-repomap puts on every section: aliases are local to their window. */
export const SCOPE_NOTE = "Aliases, abbreviations and shorthand defined inside this section apply only within this "
  + "section; other sections may reuse the same symbols with different meanings.";

export function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** The project's `.pi/kb.json` wins over the agent directory's; null when neither exists. */
export function findConfig(cwd, dir = agentDir()) {
  for (const path of [join(cwd, ".pi", CONFIG_NAME), join(dir, CONFIG_NAME)]) {
    if (!existsSync(path)) continue;
    let value;
    try { value = JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`${path} を読めません: ${error.message}`); }
    const stores = Array.isArray(value?.stores) ? value.stores : null;
    if (!stores?.length || !stores.every((s) => s && typeof s.name === "string" && typeof s.url === "string")) {
      throw new Error(`${path} の stores には {"name","url"} を1つ以上指定してください。`);
    }
    return { path, stores, cacheDir: typeof value.cacheDir === "string" ? value.cacheDir : undefined };
  }
  return null;
}

function cacheRoot(config) {
  return config.cacheDir || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-kb");
}

async function git(repo, args, options = {}) {
  const { stdout } = await run("git", ["-C", repo, ...args], { maxBuffer: 256 * 1024 * 1024, timeout: 120_000, ...options });
  return stdout;
}

async function gitOk(repo, args) {
  try { await git(repo, args); return true; } catch { return false; }
}

/** Bare cache of a store repository, fetched on every call; returns its revision. */
export async function syncStore(store, config) {
  const repo = join(cacheRoot(config), `${createHash("sha256").update(store.url).digest("hex").slice(0, 24)}.git`);
  if (!existsSync(repo)) {
    mkdirSync(repo, { recursive: true });
    await git(repo, ["init", "--bare", "--quiet"]);
    await git(repo, ["remote", "add", "origin", store.url]);
  }
  const branch = store.branch || await defaultBranch(store.url);
  try {
    await git(repo, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:refs/heads/store`]);
  } catch (error) {
    // Offline: an earlier fetch still serves the saved KB.
    if (!await gitOk(repo, ["rev-parse", "--verify", "refs/heads/store"])) {
      throw new Error(`保存先 ${store.name} (${store.url}) を取得できません: ${String(error.stderr || error.message).trim().split("\n").at(-1)}`);
    }
  }
  return { repo, revision: (await git(repo, ["rev-parse", "refs/heads/store"])).trim(), branch };
}

async function defaultBranch(url) {
  const { stdout } = await run("git", ["ls-remote", "--symref", url, "HEAD"], { timeout: 120_000 });
  const line = stdout.split("\n").find((value) => value.startsWith("ref: refs/heads/"));
  if (!line) throw new Error(`保存先の既定ブランチがありません: ${url}`);
  return line.split("\t")[0].slice("ref: refs/heads/".length);
}

function infoName(file) {
  return file === "latest.json" ? "info.json" : `${file.replace(/\.json$/, "")}.info.json`;
}

function normalizeFile(file) {
  if (!file) return "latest.json";
  return file.endsWith(".json") ? file : `${file}.json`;
}

/** Each plaintext as a numbered section that bounds the scope of its own aliases (as kb-repomap does). */
export function windowSections(info, files) {
  const windows = Array.isArray(info?.windows) ? info.windows : [];
  return files.map(([, text], index) => {
    const total = files.length;
    const title = windows.length === total ? windows[index]?.name : undefined;
    const heading = `## KB section ${index + 1}/${total}${title ? `: ${title}` : ""}`;
    return `${heading}\n> ${SCOPE_NOTE}\n\n${text.trim()}\n\n## End of KB section ${index + 1}/${total}`;
  });
}

/** Same result as `kb export NAME --decrypted`, read straight from the store repository with git. */
export async function exportDecrypted(config, name, { store: selected, file } = {}) {
  const filename = normalizeFile(file);
  const stores = config.stores.filter((s) => !selected || s.name === selected);
  if (!stores.length) throw new Error(`保存先 ${selected} は ${config.path} にありません。`);
  for (const store of stores) {
    const { repo, revision } = await syncStore(store, config);
    if (!await gitOk(repo, ["cat-file", "-e", `${revision}:${name}/${infoName(filename)}`])) continue;
    const info = JSON.parse(await git(repo, ["show", `${revision}:${name}/${infoName(filename)}`]));
    const prefix = `${name}/decrypt/${filename.replace(/\.json$/, "")}`;
    const listing = (await git(repo, ["ls-tree", "-r", "--name-only", revision, prefix])).split("\n").filter(Boolean);
    const present = new Set(listing);
    const files = [];
    for (const path of listing) {
      if (!path.endsWith("/raw.txt")) continue;
      const knowledge = `${path.slice(0, -"raw.txt".length)}knowledge.txt`;
      const chosen = present.has(knowledge) ? knowledge : path;
      files.push([chosen, await git(repo, ["show", `${revision}:${chosen}`])]);
    }
    if (!files.length) {
      throw new Error(`復号済みKBがありません: ${name}/${filename}。KBの作成者に \`kb decrypt ${name}\` を依頼してください。`);
    }
    const parts = windowSections(info, files);
    let developer = "";
    try { developer = await git(repo, ["show", `${revision}:${name}/dev.txt`]); } catch {}
    if (developer.trim()) parts.push(`## KB developer notes\n\n${developer.trimEnd()}`);
    return { version: 2, kind: "decrypted", name, store: store.name, store_revision: revision, file: filename, info, text: `${parts.join("\n\n")}\n` };
  }
  throw new Error(`KB「${name}」は保存先 (${stores.map((s) => s.name).join(", ")}) にありません。/kb list で確認してください。`);
}

/** `name  store  commit  branch  files` rows, like `kb list`. */
export async function listKbs(config) {
  const rows = [];
  for (const store of config.stores) {
    const { repo, revision } = await syncStore(store, config);
    const paths = (await git(repo, ["ls-tree", "-r", "--name-only", revision])).split("\n").filter(Boolean);
    const names = [...new Set(paths.filter((p) => /^[^/]+\/info\.json$/.test(p)).map((p) => p.split("/")[0]))].sort();
    for (const name of names) {
      let info = {};
      try { info = JSON.parse(await git(repo, ["show", `${revision}:${name}/info.json`])); } catch {}
      const decrypted = paths.some((p) => p.startsWith(`${name}/decrypt/latest/`) && p.endsWith("/raw.txt"));
      const commit = typeof info.source_commit === "string" ? info.source_commit.slice(0, 12) : "未作成";
      rows.push(`${name}\t${store.name}\t${commit}\t${info.branch ?? "-"}\t${decrypted ? "復号済み" : "未復号"}`);
    }
  }
  return rows.join("\n");
}
