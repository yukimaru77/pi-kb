import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ENTRY, MESSAGE, createInsertion, describeFailure, selectionFromBranch, insertionsFromBranch, parseCommand, validateSnapshot } from "./core.mjs";

const execute = promisify(execFile);
const usage = "/kb 名前 · /kb list · /kb status";

export default function kbExtension(pi) {
  let loading = false;
  const updateStatus = (ctx) => {
    const entries = insertionsFromBranch(ctx.sessionManager.getBranch());
    ctx.ui.setStatus("pi-kb", entries.length ? `KB挿入: ${entries.length}件` : undefined);
  };
  pi.on("session_start", (_event, ctx) => {
    const legacy = selectionFromBranch(ctx.sessionManager.getBranch());
    if (legacy) {
      // The old always-prefix selection held encrypted blobs. Clear it; plaintext must be loaded explicitly.
      pi.appendEntry(ENTRY, { snapshot: null });
      ctx.ui.notify(`旧設定のKB「${legacy.name}」は暗号化方式のため挿入しませんでした。必要なら /kb ${legacy.name} で読み込み直してください。`, "warning");
    }
    updateStatus(ctx);
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
        const sessionId = ctx.sessionManager.getSessionId();
        const leafId = ctx.sessionManager.getLeafId();
        let stdout;
        try {
          ({ stdout } = await execute(process.env.PI_KB_COMMAND || "kb", command.action === "list" ? ["list"] : command.argv, {
            cwd: ctx.cwd, maxBuffer: 128 * 1024 * 1024, timeout: 120_000,
          }));
        } catch (error) {
          throw new Error(describeFailure(error));
        }
        if (command.action === "list") {
          ctx.ui.notify(stdout.trim() || "登録済みKBはありません。", "info");
          return;
        }
        if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId || !ctx.isIdle()) {
          throw new Error("読み込み中に会話が進んだため、適用していません。もう一度 /kb を実行してください。");
        }
        let parsed;
        try { parsed = JSON.parse(stdout); } catch { throw new Error("kb export --decrypted の出力がJSONではありません。"); }
        const snapshot = validateSnapshot(parsed);
        pi.sendMessage(createInsertion(snapshot), { triggerTurn: false });
        updateStatus(ctx);
        ctx.ui.notify(`KB「${snapshot.name}」を現在の会話位置へ平文で挿入しました（${snapshot.text.length.toLocaleString("en-US")}字）。以後は通常のコンパクト対象です。`, "info");
      } catch (error) {
        ctx.ui.notify(`KB: ${error.message}`, "error");
      } finally {
        if (acquired) loading = false;
      }
    },
  });
}
