// lib.mjs — debate.mjs / parallel.mjs 共享:多平台 provider 解析 + OpenAI 兼容调用 + 降级链
// 平台与 key 在 providers.json 配置(apiKey 字段填 key,或 apiKeyEnv 指向环境变量名)。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 显示用短名:bigmodel@glm-4.7-flash → glm-4.7-flash
export const SHORT = (spec) => spec.split("@").pop().split("/").pop().replace(":free", "");

export function loadProviders() {
  const cfg = JSON.parse(readFileSync(join(HERE, "providers.json"), "utf8"));
  const out = {};
  for (const [name, p] of Object.entries(cfg)) {
    const key =
      p.apiKey ||
      process.env[p.apiKeyEnv || ""] ||
      (name === "openrouter" ? process.env.OPENROUTER_API_KEY : undefined);
    out[name] = { ...p, key };
  }
  return out;
}

// 模型规格:"provider@model" 或裸 model(默认走 openrouter,兼容旧用法)
export function resolveModel(spec, providers) {
  let name, model;
  if (spec.includes("@")) {
    const i = spec.indexOf("@");
    name = spec.slice(0, i);
    model = spec.slice(i + 1);
  } else {
    name = "openrouter";
    model = spec;
  }
  const p = providers[name];
  if (!p) throw new Error(`providers.json 里没有 "${name}" 这个平台(规格: ${spec})。已配置: ${Object.keys(providers).join(", ")}`);
  if (!p.baseURL) throw new Error(`providers.json 中平台 "${name}" 缺少 baseURL`);
  if (!p.key) throw new Error(`平台 "${name}" 缺少 API key:在 providers.json 填 apiKey 字段,或设置环境变量 ${p.apiKeyEnv || "OPENROUTER_API_KEY"}`);
  return { provider: name, model, baseURL: p.baseURL.replace(/\/+$/, ""), key: p.key };
}

// 批量解析候选链:解析失败的候选(缺 key/平台错)打警告后跳过,不炸整体
export function resolveChain(specs, providers, role = "候选") {
  const out = [];
  for (const s of specs) {
    try {
      out.push(resolveModel(s, providers));
    } catch (e) {
      console.error(`[warn] ${role} "${s}" 不可用,已跳过: ${e.message}`);
    }
  }
  return out;
}

// OpenAI 兼容 chat 调用;429 先原地等待重试一次,仍失败则抛出交给上层降级
export async function chat(resolved, messages, maxTokens = 2000, timeoutMs = 120000) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${resolved.baseURL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${resolved.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: resolved.model, messages, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 && attempt === 1) {
        await sleep(10000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const choice = data.choices?.[0];
      const text = choice?.message?.content;
      if (!text || !text.trim()) {
        if (choice?.message?.reasoning_content || choice?.finish_reason === "length")
          throw new Error("思考型模型把 max_tokens 花在了思考上(content 为空),请加大 max_tokens");
        throw new Error("空响应");
      }
      return text.trim();
    } catch (e) {
      // 超时统一转成明确错误,429 重试路径之外的异常直接上抛
      if (e.name === "TimeoutError" || /aborted|timed out/i.test(e.message)) {
        if (attempt === 1 && e.name !== "TimeoutError") { await sleep(10000); continue; }
        throw new Error(`超时(${Math.round(timeoutMs / 1000)}s,可用 --timeout 调大)`);
      }
      if (e.message?.startsWith("HTTP 429") && attempt === 1) { await sleep(10000); continue; }
      throw e;
    }
  }
}

// 降级链:按顺序尝试候选模型,第一个成功的返回;全部失败抛出汇总错误
export async function chatChain(candidates, messages, maxTokens = 2000, opts = {}) {
  const { timeoutMs = 120000, label = "call" } = opts;
  const errors = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    try {
      const text = await chat(c, messages, maxTokens, timeoutMs);
      if (i > 0) console.error(`  ↳ [${label}] 降级成功 → ${c.provider}/${c.model}`);
      return { text, used: c };
    } catch (e) {
      errors.push(`${c.provider}/${c.model}: ${e.message.slice(0, 100)}`);
      console.error(`  ↳ [${label}] ${c.provider}/${c.model} 失败(${String(e.message).slice(0, 60)})${i < candidates.length - 1 ? ",降级到下一个候选" : ",候选全部失败"}`);
    }
  }
  throw new Error(`所有候选模型失败:\n  ${errors.join("\n  ")}`);
}

// 从模型输出里抠 JSON(容忍 ``` 代码块和前后废话)
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const m = src.match(/\[[\s\S]*\]/) || src.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("输出里找不到 JSON");
  return JSON.parse(m[0]);
}

// OpenRouter 免费模型池实时列表(公开接口,无需 key)
export async function listFreeOpenRouter() {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`拉取模型列表失败: HTTP ${res.status}`);
  const { data } = await res.json();
  const free = data
    .filter((m) => m.pricing?.prompt === "0" && m.pricing?.completion === "0")
    .map((m) => m.id);
  console.log(`当前 OpenRouter 免费模型(${free.length} 个):`);
  for (const id of free) console.log("  " + id);
  console.log('\n辩论/派发时写 "openrouter@<模型id>" 或裸模型 id 即可;国内平台写 "bigmodel@glm-4.7-flash" 这类');
}

export async function setupProxy() {
  const px = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!px || process.env.NODE_USE_ENV_PROXY) return;
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(px));
  } catch {
    console.error(`[warn] 检测到 HTTPS_PROXY=${px},但本 Node 版本不原生支持且未安装 undici,代理不生效`);
  }
}
