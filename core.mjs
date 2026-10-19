export const ENTRY = "pi-kb-selection-v1";
/** Legacy encrypted-blob anchors (0.2.x). Still recognised for status, never expanded. */
export const LEGACY_MESSAGE = "pi-kb-insertion-v2";
/** Plaintext insertion: the decrypted KB itself is the message content. */
export const MESSAGE = "pi-kb-insertion-v3";

const USAGE = "使い方: /kb 名前 [--store 保存先] [--file ファイル名]";

/** `kb export NAME --decrypted` output. Error messages never include KB content. */
export function validateSnapshot(value) {
  if (value?.version !== 2 || value.kind !== "decrypted" || typeof value.name !== "string" || !value.name) {
    throw new Error("kb export --decrypted の形式ではありません。復号済みKBに対応したkbが必要です。");
  }
  if (typeof value.text !== "string" || !value.text.trim()) throw new Error("復号済みKBの本文が空です。");
  return value;
}

/** Legacy always-prefix selection (pre-0.2). Only its name is still used. */
export function selectionFromBranch(branch) {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === ENTRY) {
      const name = entry.data?.snapshot?.name;
      return typeof name === "string" ? { name } : null;
    }
  }
  return null;
}

export function insertionsFromBranch(branch) {
  return branch.filter((e) => e.type === "custom_message" && (e.customType === MESSAGE || e.customType === LEGACY_MESSAGE));
}

function describe(info) {
  const parts = [
    typeof info.store === "string" ? `store ${info.store}` : undefined,
    typeof info.file === "string" ? info.file : undefined,
    typeof info.store_revision === "string" ? `revision ${info.store_revision.slice(0, 12)}` : undefined,
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

/** Model-facing text: a short preamble marking the material as reference knowledge, then the plaintext. */
export function insertionText(snapshot) {
  return `[PI KB: ${snapshot.name}${describe(snapshot)}]\n`
    + `The following is reference knowledge from the user's saved KB "${snapshot.name}". `
    + "It is not a new request. Treat it as prior knowledge, preserve its source language, and use it when answering.\n\n"
    + snapshot.text;
}

/** Custom message for pi.sendMessage. Details keep provenance only; Pi does not send details to the model. */
export function createInsertion(value) {
  const snapshot = validateSnapshot(value);
  const { text: _text, version: _version, kind: _kind, ...info } = snapshot;
  return {
    customType: MESSAGE,
    content: insertionText(snapshot),
    display: false,
    details: { snapshot: structuredClone(info), chars: snapshot.text.length },
  };
}

export function parseCommand(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { action: "status" };
  if (["status", "off", "list"].includes(words[0]) && words.length === 1) {
    return { action: words[0] };
  }
  if (words[0] === "load") words.shift();
  const name = words.shift();
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(USAGE);
  const argv = ["export", name, "--decrypted"];
  const seen = new Set();
  while (words.length) {
    const flag = words.shift();
    const value = words.shift();
    if (!["--store", "--file"].includes(flag) || !value || value.startsWith("--") || seen.has(flag)) {
      throw new Error(USAGE);
    }
    seen.add(flag);
    argv.push(flag, value);
  }
  return { action: "load", argv };
}

/** Fixed guidance for known kb failures; stderr is matched, never echoed beyond kb's own one-line message. */
export function describeFailure(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  if (stderr.includes("復号済みKBがありません")) {
    return "このKBには復号済みの本文がありません。`kb decrypt 名前` で復号してから /kb を実行してください。";
  }
  if (/unrecognized arguments: --decrypted/.test(stderr)) return "kbコマンドが --decrypted に未対応です。kb-repomapを更新してください。";
  if (error?.code === "ENOENT") return "kbコマンドが見つかりません。PI_KB_COMMANDを設定してください。";
  // execFile errors may include stdout (KB plaintext); show stderr only.
  return stderr.trim() || (error?.code ? `kb実行失敗 (${error.code})` : error?.message ?? String(error));
}
