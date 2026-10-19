import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { ENTRY, MESSAGE, validateSnapshot, selectionFromBranch, insertionsFromBranch, supportsKB, expandInsertions, parseCommand } from "./core.mjs";
import { attachCompactionAdapter } from "./compaction-adapter.mjs";

const execute = promisify(execFile);
const usage = "/kb 名前 · /kb list · /kb status";

export default function kbExtension(pi) {
  let loading = false;
  let detach;
  const insert = (snapshot) => pi.sendMessage({
    customType: MESSAGE,
    content: `[PI_KB:${randomUUID()}] Encrypted knowledge is unavailable unless pi-kb is enabled with Codex. Do not infer the missing content.`,
    display: false,
    details: { snapshot },
  }, { triggerTurn: false });
  const updateStatus = (ctx) => {
    const entries = insertionsFromBranch(ctx.sessionManager.getBranch());
    ctx.ui.setStatus("pi-kb", entries.length ? `KB挿入: ${entries.length}件` : undefined);
  };
  pi.on("session_start", (_event, ctx) => {
    detach?.();
    const manager = ctx.sessionManager;
    detach = attachCompactionAdapter(ctx.modelRegistry.runtime, () => manager.getBranch());
    const legacy = selectionFromBranch(ctx.sessionManager.getBranch());
    if (legacy) {
      pi.appendEntry(ENTRY, { snapshot: null });
      insert(legacy);
      ctx.ui.notify(`旧設定のKB「${legacy.name}」を現在の会話位置へ一度挿入しました。`, "info");
    }
    updateStatus(ctx);
  });
  pi.on("session_shutdown", () => { detach?.(); detach = undefined; });
  pi.on("session_tree", (_event, ctx) => updateStatus(ctx));
  pi.on("model_select", (_event, ctx) => {
    updateStatus(ctx);
    if (insertionsFromBranch(ctx.sessionManager.getBranch()).length && !supportsKB(ctx.model)) {
      ctx.ui.notify("暗号化KBの履歴を読み取れるのはCodexモデルです。", "warning");
    }
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (supportsKB(ctx.model)) return expandInsertions(event.payload, ctx.sessionManager.getBranch());
  });

  pi.registerCommand("kb", {
    description: "KBのBlob列とdev.txtを現在の会話位置へ挿入: /kb 名前 (list/status)",
    handler: async (args, ctx) => {
      let acquired = false;
      try {
        const command = parseCommand(args);
        if (command.action === "status") {
          const entries = insertionsFromBranch(ctx.sessionManager.getBranch());
          ctx.ui.notify(entries.length
            ? `挿入履歴: ${entries.map((e) => e.details.snapshot.name).join(" → ")}\n挿入後は通常の会話履歴としてコンパクトされます。\n${usage}`
            : `KB挿入なし。${usage}`, "info");
          return;
        }
        if (loading) throw new Error("KBを読み込み中です。完了後に実行してください。");
        if (!ctx.isIdle()) throw new Error("応答の完了後に /kb を実行してください。");
        if (command.action === "off") {
          ctx.ui.notify("KBは会話に一度挿入する方式になりました。offで削除はできません。挿入前に戻す場合は /tree を使ってください。", "info");
          return;
        }
        if (command.action === "load" && !supportsKB(ctx.model)) {
          throw new Error("暗号化KBにはCodexモデルを選択してください。");
        }
        loading = true;
        acquired = true;
        const sessionId = ctx.sessionManager.getSessionId();
        const leafId = ctx.sessionManager.getLeafId();
        const { stdout } = await execute(process.env.PI_KB_COMMAND || "kb", command.action === "list" ? ["list"] : command.argv, {
          cwd: ctx.cwd, maxBuffer: 128 * 1024 * 1024, timeout: 120_000,
        });
        if (command.action === "list") {
          ctx.ui.notify(stdout.trim() || "登録済みKBはありません。", "info");
          return;
        }
        if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId || !ctx.isIdle()) {
          throw new Error("読み込み中に会話が進んだため、適用していません。もう一度 /kb を実行してください。");
        }
        const snapshot = validateSnapshot(JSON.parse(stdout));
        insert(snapshot);
        updateStatus(ctx);
        ctx.ui.notify(`KB「${snapshot.name}」を現在の会話位置へ挿入しました。以後は通常のコンパクト対象です。`, "info");
      } catch (error) {
        // execFile errors may include stdout (opaque KB data); show stderr only.
        ctx.ui.notify(`KB: ${error.stderr?.trim() || (error.code ? `kb実行失敗 (${error.code})` : error.message)}`, "error");
      } finally {
        if (acquired) loading = false;
      }
    },
  });
}
