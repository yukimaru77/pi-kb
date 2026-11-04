import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ENTRY, MESSAGE, createInsertion, describeFailure, kbNames, selectionFromBranch, insertionsFromBranch, parseCommand, statusText, validateSnapshot } from "./core.mjs";

const execute = promisify(execFile);
const usage = "/kb 名前 · /kb list · /kb status";

/** `kb NAME pi` sets this to the /kb arguments; the first session of the process loads that KB once. */
export const AUTOLOAD_ENV = "PI_KB_AUTOLOAD";

export default function kbExtension(pi) {
  let loading = false;
  let autoloadPending = Boolean(process.env[AUTOLOAD_ENV]?.trim());
  const updateStatus = (ctx) => {
    ctx.ui.setStatus("pi-kb", statusText(insertionsFromBranch(ctx.sessionManager.getBranch())));
  };

  /** Same effect as `/kb ...`: export the decrypted KB and insert it at the current position. */
  const load = async (command, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    let stdout;
    try {
      ({ stdout } = await execute(process.env.PI_KB_COMMAND || "kb", command.argv, {
        cwd: ctx.cwd, maxBuffer: 128 * 1024 * 1024, timeout: 120_000,
      }));
    } catch (error) {
      throw new Error(describeFailure(error));
    }
    if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId || !ctx.isIdle()) {
      throw new Error("読み込み中に会話が進んだため、適用していません。もう一度 /kb を実行してください。");
    }
    let parsed;
    try { parsed = JSON.parse(stdout); } catch { throw new Error("kb export --decrypted の出力がJSONではありません。"); }
    const snapshot = validateSnapshot(parsed);
    pi.sendMessage(createInsertion(snapshot), { triggerTurn: false });
    updateStatus(ctx);
    return snapshot;
  };

  pi.on("session_start", async (_event, ctx) => {
    const legacy = selectionFromBranch(ctx.sessionManager.getBranch());
    if (legacy) {
      // The old always-prefix selection held encrypted blobs. Clear it; plaintext must be loaded explicitly.
      pi.appendEntry(ENTRY, { snapshot: null });
      ctx.ui.notify(`旧設定のKB「${legacy.name}」は暗号化方式のため挿入しませんでした。必要なら /kb ${legacy.name} で読み込み直してください。`, "warning");
    }
    updateStatus(ctx);
    if (!autoloadPending) return;
    autoloadPending = false;
    loading = true;
    try {
      const command = parseCommand(process.env[AUTOLOAD_ENV]);
      if (command.action !== "load") throw new Error(`${AUTOLOAD_ENV} にはKB名を指定してください。`);
      const name = command.argv[1];
      if (kbNames(insertionsFromBranch(ctx.sessionManager.getBranch())).includes(name)) {
        ctx.ui.notify(`KB「${name}」はこのセッションに挿入済みです。`, "info");
        return;
      }
      const snapshot = await load(command, ctx);
      ctx.ui.notify(`KB「${snapshot.name}」を読み込んで起動しました（${snapshot.text.length.toLocaleString("en-US")}字）。`, "info");
    } catch (error) {
      ctx.ui.notify(`KB: ${error.message}`, "error");
    } finally {
      loading = false;
    }
  });
  pi.on("session_tree", (_event, ctx) => updateStatus(ctx));
  pi.on("model_select", (_event, ctx) => updateStatus(ctx));

  pi.registerCommand("kb", {
    description: "復号済みKBとdev.txtを現在の会話位置へ平文で挿入: /kb 名前 (list/status)",
    handler: async (args, ctx) => {
      let acquired = false;
      try {
        const command = parseCommand(args);
        if (command.action === "status") {
          const entries = insertionsFromBranch(ctx.sessionManager.getBranch());
          ctx.ui.notify(entries.length
            ? `挿入履歴: ${entries.map((e) => `${e.details?.snapshot?.name ?? "?"}${e.customType === MESSAGE ? "" : "(旧暗号化)"}`).join(" → ")}\n挿入後は通常の会話履歴としてコンパクトされます。\n${usage}`
            : `KB挿入なし。${usage}`, "info");
          return;
        }
        if (loading) throw new Error("KBを読み込み中です。完了後に実行してください。");
        if (!ctx.isIdle()) throw new Error("応答の完了後に /kb を実行してください。");
        if (command.action === "off") {
          ctx.ui.notify("KBは会話に一度挿入する方式です。offで削除はできません。挿入前に戻す場合は /tree を使ってください。", "info");
          return;
        }
        loading = true;
        acquired = true;
        if (command.action === "list") {
          let stdout;
          try {
            ({ stdout } = await execute(process.env.PI_KB_COMMAND || "kb", ["list"], {
              cwd: ctx.cwd, maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
            }));
          } catch (error) {
            throw new Error(describeFailure(error));
          }
          ctx.ui.notify(stdout.trim() || "登録済みKBはありません。", "info");
          return;
        }
        const snapshot = await load(command, ctx);
        ctx.ui.notify(`KB「${snapshot.name}」を現在の会話位置へ平文で挿入しました（${snapshot.text.length.toLocaleString("en-US")}字）。以後は通常のコンパクト対象です。`, "info");
      } catch (error) {
        ctx.ui.notify(`KB: ${error.message}`, "error");
      } finally {
        if (acquired) loading = false;
      }
    },
  });
}
