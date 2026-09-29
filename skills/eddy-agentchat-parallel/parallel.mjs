#!/usr/bin/env node
/**
 * 多模型并行分发 → 验收 → 总结收尾(OpenAI 兼容多平台,零依赖)
 * 对标 AgentChat-IndependentTasks:拆解 → 派发 → 校验门 → 合成,走官方 API,零封号风险。
 *
 * 用法:
 *   node parallel.mjs "总任务..."                   # 裁判模型自动拆解成 N 个独立子任务,并行分发
 *   node parallel.mjs --tasks="子任务1|子任务2|子任务3" "总目标说明"   # 自己定子任务,跳过拆解
 *   node parallel.mjs --split=6 "总任务"            # 指定拆成几个子任务
 *   node parallel.mjs --timeout=180000 "总任务"     # 单次调用超时(默认 120000ms),超时自动降级
 *   node parallel.mjs --workers="bigmodel@glm-4.7-flash,openrouter@qwen/qwen3.8-27b:free" --judge=bigmodel@glm-4.7-flash "总任务"
 *   node parallel.mjs --list
 *
 * 平台与 key:providers.json 里配置各平台的 baseURL + key/apiKeyEnv
 *   (openrouter / bigmodel / siliconflow / modelscope 已预置)
 * 模型规格:"平台@模型" 或裸模型 id(默认 openrouter)。
 *
 * 流程:拆解(planner)→ 并行派发(每个子任务一个模型)→ 验收(judge 逐项 pass/fail)
 * → 不合格项换模型补发一次 → 复验 → 最终总结合成。任何一步失败不炸全场。
 * 超时/降级:所有调用带超时(默认 120s);拆解/验收/总结走裁判降级链;执行失败自动
 * 换下一个 worker 重试。glm-4.7-flash 免费档限 1 并发,适合当裁判;多路 worker 建议
 * 用 siliconflow / modelscope / openrouter 的多并发免费模型。
 *
 * 额度账(默认 4 worker):典型一场 ≈ 1 拆解 + 4 执行 + 1 验收 + 1 合成 = 7 次调用;
 * 有补发最多 ~11 次。
 *
 * 代理:Node ≥24 用 NODE_USE_ENV_PROXY=1;旧版需 npm i undici(检测到 HTTPS_PROXY 自动尝试)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { sleep, SHORT, loadProviders, resolveModel, resolveChain, chat, chatChain, extractJson, listFreeOpenRouter, setupProxy } from "./lib.mjs";

// 默认阵容:工人用多并发的免费快模型(硅基流动 + 魔搭 + 海外备份),裁判用魔搭旗舰
const DEFAULT_WORKERS = [
  "siliconflow@Qwen/Qwen2.5-7B-Instruct",              // 硅基流动:多并发,快
  "modelscope@Qwen/Qwen3.8-Flash-Next",                // 魔搭:Qwen flash
  "modelscope@stepfun-ai/Step-3.7-Flash",              // 魔搭:阶跃
  "modelscope@meituan-longcat/LongCat-Flash-Lite",     // 魔搭:美团 LongCat
  "openrouter@inclusionai/ling-3.0-flash-sante:free",  // 海外通道备份
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

// 拆解:把总任务切成 N 个相互独立、可并行的子任务
async function planSplit(judgeChain, topic, n, timeoutMs) {
  const { text: raw } = await chatChain(
    judgeChain,
    [
      {
        role: "system",
        content:
          `你是任务调度师。把用户的总任务拆解成 ${n} 个相互独立、可并行执行的子任务:每个子任务单独完成即有交付价值,禁止互相依赖,合在一起恰好覆盖总任务。` +
          '只输出 JSON 数组,不要其他文字:[{"id":"T1","title":"子任务短标题","requirement":"具体要求,包含质量标准"}]',
      },
      { role: "user", content: topic },
    ],
    1200,
    { timeoutMs, label: "任务拆解" }
  );
  const tasks = extractJson(raw);
  if (!Array.isArray(tasks) || !tasks.length) throw new Error("拆解结果不是非空数组");
  return tasks.map((t, i) => ({
    id: String(t.id || `T${i + 1}`),
    title: String(t.title || t.id || `子任务${i + 1}`),
    requirement: String(t.requirement || t.description || t.title || ""),
  }));
}

// 执行一个子任务:构造消息(不写死模型名,降级后 persona 依然成立)
function executeMessages(worker, topic, task) {
  return [
    {
      role: "system",
      content:
        "你是执行者。只负责把你分到的子任务做完,输出可直接使用的完整结果(成品本身,不是计划或思路)。" +
        "用 Markdown,按子任务要求组织内容。",
    },
    { role: "user", content: `总任务背景:${topic}\n\n你负责的子任务【${task.id}: ${task.title}】\n要求:${task.requirement}` },
  ];
}

// 执行 + 单级降级:主 worker 超时/报错时自动换备用 worker
async function executeWithFallback(primary, spare, topic, task, timeoutMs, label) {
  const { text, used } = await chatChain(
    [primary, spare].filter(Boolean),
    executeMessages(primary, topic, task),
    2000,
    { timeoutMs, label }
  );
  return { text, used };
}

// 验收:judge 逐项判定
async function review(judgeChain, topic, results, timeoutMs) {
  const payload = results
    .map((r) => `【${r.task.id}: ${r.task.title}】(执行者 ${SHORT(r.worker.model)})\n要求:${r.task.requirement}\n提交内容:\n${r.text}`)
    .join("\n\n===\n\n");
  const { text: raw } = await chatChain(
    judgeChain,
    [
      {
        role: "system",
        content:
          '你是验收官。逐项检查每个子任务的提交内容:是否完成要求、是否答非所问、质量是否可用。' +
          '只输出 JSON 数组,不要其他文字:[{"id":"T1","pass":true/false,"reason":"一句话"}]',
      },
      { role: "user", content: `总任务:${topic}\n\n${payload}` },
    ],
    1200,
    { timeoutMs, label: "验收" }
  );
  const verdicts = extractJson(raw);
  const byId = new Map(verdicts.map((v) => [String(v.id), v]));
  return results.map((r) => {
    const v = byId.get(r.task.id) || {};
    return { ...r, pass: v.pass !== false && !r.error, reason: String(v.reason || (r.error ? "执行失败" : "未给出意见")) };
  });
}

async function main() {
  await setupProxy();
  if (hasFlag("list")) return listFreeOpenRouter();

  const topic = arg("file") ? readFileSync(arg("file"), "utf8").trim()
    : argv.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!topic) {
    console.error('用法: node parallel.mjs "总任务"   (或 --tasks="A|B|C" / --file=plan.txt / --list)');
    process.exit(64);
  }

  const providers = loadProviders();
  const timeoutMs = parseInt(arg("timeout") || "120000", 10);
  const workerSpecs = (arg("workers") || DEFAULT_WORKERS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const judgeSpec = arg("judge") || DEFAULT_JUDGE;

  // 提前解析:工人缺 key/写错平台打警告跳过;裁判构建降级链(主裁判 + 旗舰替补)
  const workerModels = resolveChain(workerSpecs, providers, "worker");
  if (!workerModels.length) {
    console.error("没有可用的 worker 模型:检查 providers.json 里的 key 是否已填");
    process.exit(2);
  }
  const judge = resolveModel(judgeSpec, providers);
  const judgeChain = [judge, ...resolveChain(JUDGE_FALLBACKS.filter((s) => s !== judgeSpec), providers, "裁判候选")];

  // 1. 子任务来源:用户指定 or 拆解
  let tasks;
  if (arg("tasks")) {
    tasks = arg("tasks").split("|").map((s) => s.trim()).filter(Boolean)
      .map((t, i) => ({ id: `T${i + 1}`, title: t.slice(0, 30), requirement: t }));
    console.log(`使用手动指定的 ${tasks.length} 个子任务`);
  } else {
    const n = parseInt(arg("split") || String(workerModels.length), 10);
    console.log(`裁判(${SHORT(judge.model)})拆解总任务为 ${n} 个子任务 ...`);
    tasks = await planSplit(judgeChain, topic, n, timeoutMs);
    console.log(`拆解完成: ${tasks.map((t) => t.id + "." + t.title).join(" / ")}\n`);
  }

  // 2. 并行派发(错峰启动;执行带单级降级:主 worker 失败自动换备用)
  console.log(`并行派发给 ${workerModels.length} 个 worker(${workerModels.map((w) => SHORT(w.model)).join(", ")})...`);
  let results = tasks.map((task, i) => ({ task, worker: workerModels[i % workerModels.length], text: "", error: null }));
  await Promise.all(results.map(async (r, i) => {
    await sleep(i * 2000);
    try {
      const idx = workerModels.indexOf(r.worker);
      const spare = workerModels[(idx + 1) % workerModels.length];
      const { text, used } = await executeWithFallback(r.worker, spare, topic, r.task, timeoutMs, `执行 ${r.task.id}`);
      r.worker = used;
      r.text = text;
    } catch (e) {
      r.error = e.message;
    }
  }));
  results.forEach((r) => console.log(`  [${r.task.id}] ${SHORT(r.worker.model)}: ${r.error ? "失败 " + r.error : "ok, " + r.text.length + " 字"}`));

  // 3. 验收
  console.log("\n裁判验收 ...");
  results = await review(judgeChain, topic, results, timeoutMs);
  results.forEach((r) => console.log(`  [${r.task.id}] ${r.pass ? "✅ 通过" : "❌ 驳回"} ${r.reason}`));

  // 4. 补发一次(换下一个 worker),再复验
  const failed = results.filter((r) => !r.pass);
  for (const r of failed) {
    const idx = workerModels.indexOf(r.worker);
    const fallback = workerModels[(idx + 1) % workerModels.length];
    console.log(`\n[${r.task.id}] 补发 → ${SHORT(fallback.model)}(${fallback.provider})`);
    try {
      const { text, used } = await executeWithFallback(fallback, workerModels[(idx + 2) % workerModels.length], topic, r.task, timeoutMs, `补发 ${r.task.id}`);
      r.worker = used;
      r.text = text;
      r.error = null;
    } catch (e) {
      r.error = e.message;
    }
  }
  if (failed.length) {
    console.log("复验补发结果 ...");
    const rechecked = await review(judgeChain, topic, results.filter((r) => failed.includes(r)), timeoutMs);
    for (const r of rechecked) {
      const orig = results.find((x) => x.task.id === r.task.id);
      Object.assign(orig, { pass: r.pass, reason: r.reason });
      console.log(`  [${r.task.id}] ${r.pass ? "✅ 通过" : "❌ 仍不通过"} ${r.reason}`);
    }
  }

  // 5. 总结合成
  console.log(`\n裁判总结收尾: ${SHORT(judge.model)} ...`);
  const merged = results
    .map((r) => `### ${r.task.id}: ${r.task.title}(执行者 ${SHORT(r.worker.model)},${r.pass ? "已验收" : "⚠️ 未通过验收"})\n${r.text}`)
    .join("\n\n");
  let final;
  try {
    final = (
      await chatChain(
        judgeChain,
        [
          {
            role: "system",
            content:
              "你是总编。多位执行者已各自完成总任务的子任务,请做收尾:" +
              "## 总体结论(总任务完成情况一段话);" +
              "## 整合交付物(把各子任务结果整合成一份连贯、去重、风格统一的完整成品);" +
              "## 遗留问题(未通过验收或质量存疑的部分,明确指出;没有则写'无')。" +
              "只依据提交内容,不要自己新造结论;发现子任务之间矛盾时指出并采信更可靠的一方。",
          },
          { role: "user", content: `总任务:${topic}\n\n各子任务提交:\n\n${merged}` },
        ],
        4000,
        { timeoutMs, label: "总结收尾" }
      )
    ).text;
    console.log("\n" + final + "\n");
  } catch (e) {
    final = `(总结合成失败: ${e.message})`;
    console.error(final);
  }

  const out =
    arg("out") ||
    `parallel-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`;
  const header =
    `# 并行分发: ${topic}\n\n` +
    `- 时间: ${new Date().toLocaleString()}\n` +
    `- workers: ${workerModels.map((w) => `${w.provider}/${w.model}`).join(", ")}\n` +
    `- 裁判/验收/总结: ${judge.provider}/${judge.model}\n\n---\n\n`;
  writeFileSync(
    out,
    header + `## 子任务与提交\n\n${merged}\n\n---\n\n## 总编收尾\n\n${final}\n`,
    "utf8"
  );
  console.log(`完整记录已保存: ${out}`);
}

main().catch((e) => {
  console.error("运行失败:", e.message);
  process.exit(1);
});
