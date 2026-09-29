#!/usr/bin/env node
/**
 * 多模型自动辩论 → 共识合成(OpenAI 兼容多平台,零依赖)
 *
 * 用法:
 *   node debate.mjs "该不该在产品里引入微服务架构?"
 *   node debate.mjs --list                          # 查看 OpenRouter 实时免费模型池
 *   node debate.mjs --rounds=6 --out=result.md "议题..."   # --rounds 是上限,达成共识会提前结束
 *   node debate.mjs --models="bigmodel@glm-4.7-flash,openrouter@qwen/qwen3.8-27b:free" "议题"
 *   node debate.mjs --judge=bigmodel@glm-4.7-flash "议题"
 *   node debate.mjs --timeout=180000 "议题"         # 单次调用超时(默认 120000ms),超时自动降级到候选
 *   node debate.mjs --file=topic.txt                # 从文件读议题
 *
 * 平台与 key:providers.json 里配置各平台的 baseURL + key/apiKeyEnv
 *   (openrouter / bigmodel / siliconflow / modelscope 已预置)
 * 模型规格:"平台@模型" 或裸模型 id(默认 openrouter)。
 * 超时/降级:裁判的共识判定与最终合成走降级链(默认 3 个旗舰候选),失败自动换下一个;
 * 辩手单次调用失败只记缺勤,不炸全场。
 *
 * 轮次自适应:每轮结束由裁判判定"是否已形成一致结论",达成即提前收工合成;
 * --rounds 只是防止吵不完的上限(默认 4)。观点一致时 1 轮就能出结论。
 * 额度账:典型一场 ≈ 4 辩手 × 1~2 轮 + 1~2 次共识判定 + 1 裁判 ≈ 6~11 次调用。
 *
 * 代理:Node ≥24 用 NODE_USE_ENV_PROXY=1;旧版需 npm i undici(检测到 HTTPS_PROXY 自动尝试)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { sleep, SHORT, loadProviders, resolveModel, resolveChain, chat, chatChain, listFreeOpenRouter, setupProxy } from "./lib.mjs";

let judgeNote = "";
let converged = false;

// 默认阵容:魔搭免费池国产模型混编 + OpenRouter 海外通道互为备份;裁判用旗舰
const DEFAULT_MODELS = [
  "modelscope@Qwen/Qwen3.5-35B-A3B",                   // 阿里 Qwen 3.5
  "modelscope@ZhipuAI/GLM-4.7-Flash",                  // 智谱
  "modelscope@stepfun-ai/Step-3.7-Flash",              // 阶跃
  "openrouter@inclusionai/ling-3.0-flash-sante:free",  // 蚂蚁 Ling(海外通道备份)
];
const DEFAULT_JUDGE = "modelscope@ZhipuAI/GLM-5.2";
const JUDGE_FALLBACKS = [
  "modelscope@Qwen/Qwen3.5-397B-A17B",
  "bigmodel@glm-4.7-flash",
  "openrouter@nvidia/nemotron-3-ultra-550b-a55b:free",
];

const argv = process.argv.slice(2);
const arg = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
};
const hasFlag = (name) => argv.includes(`--${name}`);

// 每轮结束问裁判:是否已形成一致结论。判定失败按"未达成"处理,辩论继续。
async function checkConsensus(judgeChain, topic, roundStatements, timeoutMs) {
  try {
    const { text: raw } = await chatChain(
      judgeChain,
      [
        {
          role: "system",
          content: "你是辩论主持人。阅读所有辩手截至本轮的发言,判断是否已形成实质一致——只看结论是否相容,允许措辞和论证路径的差异。",
        },
        {
          role: "user",
          content: `议题:${topic}\n\n${roundStatements}\n\n只输出 JSON,不要任何其他文字:{"consensus": true/false, "note": "若未一致,一句话指出当前核心分歧;若已一致,一句话概括共识"}`,
        },
      ],
      300,
      { timeoutMs, label: "共识判定" }
    );
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { consensus: false, note: "" };
    const j = JSON.parse(m[0]);
    return { consensus: !!j.consensus, note: String(j.note || "") };
  } catch {
    return { consensus: false, note: "" };
  }
}

async function main() {
  await setupProxy();
  if (hasFlag("list")) return listFreeOpenRouter();

  const topic = arg("file") ? readFileSync(arg("file"), "utf8").trim()
    : argv.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!topic) {
    console.error('用法: node debate.mjs "议题"   (或 --file=topic.txt / --list)');
    process.exit(64);
  }

  const providers = loadProviders();
  const timeoutMs = parseInt(arg("timeout") || "120000", 10);
  const workerSpecs = (arg("models") || DEFAULT_MODELS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const judgeSpec = arg("judge") || DEFAULT_JUDGE;
  const maxRounds = Math.max(1, parseInt(arg("rounds") || "4", 10));

  // 提前解析:辩手缺 key/写错平台打警告跳过;裁判构建降级链(主裁判 + 旗舰替补)
  const workers = resolveChain(workerSpecs, providers, "辩手");
  if (!workers.length) {
    console.error("没有可用的辩手模型:检查 providers.json 里的 key 是否已填");
    process.exit(2);
  }
  const judge = resolveModel(judgeSpec, providers);
  const judgeChain = [judge, ...resolveChain(JUDGE_FALLBACKS.filter((s) => s !== judgeSpec), providers, "裁判候选")];

  console.log(`议题: ${topic}`);
  console.log(`辩手(${workers.length}): ${workers.map((w) => `${SHORT(w.model)}(${w.provider})`).join(", ")}`);
  console.log(`裁判: ${SHORT(judge.model)}(${judge.provider}) | 轮数上限: ${maxRounds}(达成共识即提前结束)\n`);

  const letters = "ABCDE";
  const transcript = []; // [{model, provider, letter, round, text}]
  const record = (w, letter, round, text) => transcript.push({ ...w, letter, round, text });

  for (let r = 1; r <= maxRounds; r++) {
    console.log(`── 第 ${r} 轮 ${r === 1 ? "(独立立论)" : "(交锋辩论)"} ──`);
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      const letter = letters[i];
      process.stdout.write(`[${letter}] ${SHORT(w.model)}(${w.provider}) ... `);
      const others = transcript
        .filter((t) => t.round === r - 1 && t.model !== w.model)
        .map((t) => `【辩手${t.letter}(${SHORT(t.model)})】${t.text}`)
        .join("\n\n");
      const messages =
        r === 1
          ? [
              { role: "system", content: `你是"辩手${letter}",你的底层模型是 ${w.model}。就用户给出的议题,独立、鲜明地给出你的立场与分析:先一句话亮结论,再给理由和关键取舍。不超过 400 字,不要客套。` },
              { role: "user", content: topic },
            ]
          : [
              {
                role: "system",
                content: `这是多模型辩论的第 ${r} 轮。你是"辩手${letter}"(底层模型 ${w.model}),你此前已有发言。目标是在轮数用尽前达成一致结论:如果你已认同其他辩手的主流观点,直接明确表示同意并收敛,不要为了反驳而反驳;只有存在实质分歧时才坚持,并说清理由。不超过 300 字。${judgeNote ? `\n主持人提示——当前核心分歧:${judgeNote}` : ""}`,
              },
              { role: "user", content: `议题:${topic}\n\n其他辩手上一轮发言:\n\n${others || "(暂无,请深化你上一轮的论证)"}` },
            ];
      try {
        const text = await chat(w, messages, 2000, timeoutMs);
        record(w, letter, r, text);
        console.log("ok");
      } catch (e) {
        record(w, letter, r, `(本回合发言失败: ${e.message})`);
        console.log(`失败: ${e.message}`);
      }
      await sleep(2000); // 免费档通常 20 次/分钟,错峰调用
    }
    console.log("");
    if (r < maxRounds) {
      process.stdout.write("主持人判定共识 ... ");
      const roundStatements = transcript
        .filter((t) => t.round === r)
        .map((t) => `【辩手${t.letter}(${SHORT(t.model)})】${t.text}`)
        .join("\n\n");
      const verdict = await checkConsensus(judgeChain, topic, roundStatements, timeoutMs);
      judgeNote = verdict.note;
      if (verdict.consensus) {
        converged = true;
        console.log(`第 ${r} 轮已达成一致,提前收工`);
        break;
      }
      console.log(`未一致${judgeNote ? `(${judgeNote})` : ""},继续`);
    }
  }

  console.log(`── 裁判合成共识: ${SHORT(judge.model)}(实际进行 ${new Set(transcript.map((t) => t.round)).size} 轮,${converged ? "已收敛" : "未完全收敛,按多数意见裁决"}) ──`);
  const fullTranscript = transcript
    .map((t) => `### 第${t.round}轮 · 辩手${t.letter}(${SHORT(t.model)})\n${t.text}`)
    .join("\n\n");
  let consensus;
  try {
    consensus = (
      await chatChain(
        judgeChain,
        [
          {
            role: "system",
            content:
              "你是辩论主持人。以下是多位不同厂商的 AI 辩手就同一议题的完整辩论记录。请合成统一意见,用 Markdown 输出三节:" +
              "## 共识点(所有或多数辩手认可的结论,逐条列出并注明是谁先提出的);" +
              "## 主要分歧与裁决(列出分歧点,说明你采信哪一方及理由);" +
              "## 最终建议(给出可执行的明确结论;若确无共识,给出多数意见并标注少数派异议)。" +
              "只依据辩论记录本身,不要引入外部观点。",
          },
          { role: "user", content: `议题:${topic}\n\n${fullTranscript}` },
        ],
        4000,
        { timeoutMs, label: "共识合成" }
      )
    ).text;
    console.log("\n" + consensus + "\n");
  } catch (e) {
    consensus = `(裁判合成失败: ${e.message})`;
    console.error(consensus);
  }

  const out =
    arg("out") ||
    `debate-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`;
  const header =
    `# 多模型辩论: ${topic}\n\n` +
    `- 时间: ${new Date().toLocaleString()}\n` +
    `- 辩手: ${workers.map((w) => `${w.provider}/${w.model}`).join(", ")}\n` +
    `- 裁判: ${judge.provider}/${judge.model}(实际 ${new Set(transcript.map((t) => t.round)).size} 轮,${converged ? "达成共识" : "未完全收敛,按多数意见裁决"})\n\n---\n\n`;
  const body =
    transcript.map((t) => `### 第${t.round}轮 · 辩手${t.letter}(${SHORT(t.model)})\n\n${t.text}`).join("\n\n") +
    `\n\n---\n\n## 统一意见(裁判: ${SHORT(judge.model)})\n\n${consensus}\n`;
  writeFileSync(out, header + body, "utf8");
  console.log(`完整记录已保存: ${out}`);
}

main().catch((e) => {
  console.error("运行失败:", e.message);
  process.exit(1);
});
