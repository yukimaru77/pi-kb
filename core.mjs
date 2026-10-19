export const ENTRY = "pi-kb-selection-v1";
export const MESSAGE = "pi-kb-insertion-v2";
export const BLOB_TYPES = new Set(["compaction", "compaction_summary", "context_compaction"]);

export function validateSnapshot(value) {
  if (value?.version !== 1 || typeof value.name !== "string" || !Array.isArray(value.items)) {
    throw new Error("Unsupported kb export format (expected version 1).");
  }
  let blobs = 0;
  for (const item of value.items) {
    if (BLOB_TYPES.has(item?.type)) {
      if (typeof item.encrypted_content !== "string" || !item.encrypted_content) {
        throw new Error("KB contains an empty encrypted blob.");
      }
      blobs++;
    } else if (!(item && (item.type === "message" || item.type === undefined)
      && ["user", "developer"].includes(item.role) && item.content)) {
      throw new Error("Unsupported KB item.");
    }
  }
  if (!blobs) throw new Error("KB contains no encrypted blobs.");
  return value;
}

export function selectionFromBranch(branch) {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === ENTRY) {
      return entry.data?.snapshot ? validateSnapshot(entry.data.snapshot) : null;
    }
  }
  return null;
}

export function supportsKB(model) {
  return model?.api === "openai-codex-responses";
}

export function insertionsFromBranch(branch) {
  return branch.filter((e) => e.type === "custom_message" && e.customType === MESSAGE);
}

export function expandInsertions(payload, branch) {
  if (!payload || !Array.isArray(payload.input)) throw new Error("Codex payload has no input array.");
  const insertions = new Map(insertionsFromBranch(branch).map((entry) => [entry.content, entry.details.snapshot]));
  let changed = false;
  const input = payload.input.flatMap((item) => {
    const text = item.role === "user" && Array.isArray(item.content) && item.content.length === 1
      && item.content[0].type === "input_text" ? item.content[0].text : undefined;
    const snapshot = insertions.get(text);
    if (!snapshot) return [item];
    changed = true;
    return structuredClone(validateSnapshot(snapshot).items);
  });
  // Missing anchor means compaction may have consumed it. Never resurrect it.
  return changed ? { ...payload, input } : payload;
}

export function parseCommand(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { action: "status" };
  if (["status", "off", "list"].includes(words[0]) && words.length === 1) {
    return { action: words[0] };
  }
  if (words[0] === "load") words.shift();
  const name = words.shift();
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("使い方: /kb 名前 [--store 保存先] [--file ファイル名]");
  const argv = ["export", name];
  const seen = new Set();
  while (words.length) {
    const flag = words.shift();
    const value = words.shift();
    if (!["--store", "--file"].includes(flag) || !value || value.startsWith("--") || seen.has(flag)) {
      throw new Error("使い方: /kb 名前 [--store 保存先] [--file ファイル名]");
    }
    seen.add(flag);
    argv.push(flag, value);
  }
  return { action: "load", argv };
}
