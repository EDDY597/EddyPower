# EddyPower

EddyPower 是一套面向 AI 智能体的 **Skill 集合**（playbook 合集）。每个 skill 一个独立目录（`skills/<name>/SKILL.md`），可单独安装到 Reasonix、Claude Code、Codex 等支持 SKILL.md 的 agent，也可整个仓库引入。

命名规范：所有 skill 以 `eddy-` 开头，kebab-case 描述性命名。

## 安装

### Reasonix

把 skill 目录放到全局或项目级 skills 目录即可：

- 全局：`C:\Users\<你>\AppData\Roaming\reasonix\skills\<skill-name>\SKILL.md`
- 项目：`<repo>\.reasonix\skills\<skill-name>\SKILL.md`

或使用 `install_skill` / `install_source` 从本仓库安装。

### Claude Code / Codex / 其他

复制 `skills/<skill-name>/` 到对应 agent 的 skills 目录。

## Skill 列表

### eddy-word-headings

把 Word/WPS `.docx` 文档的标题 1~4 统一为规范的多级列表编号（支持 `一/1./1.1/1.1.1` 等格式），解决标题编号不联动、需手动「重新编号」、重新编号后自动缩进等问题，并规范化正文与标题间距。

- 触发：`/eddy-word-headings`，或对 agent 说「标题统一化 / 标题规范化 / 多级列表」。
- 详见 [`skills/eddy-word-headings/SKILL.md`](skills/eddy-word-headings/SKILL.md)。

### eddy-agentchat-debate

多模型自动辩论并合成统一意见：多个跨厂商模型（默认智谱 GLM-4.7-Flash、阿里 Qwen3.5、阶跃 Step-3.7、蚂蚁 Ling）就同一议题独立立论 → 多轮交锋 → 旗舰裁判（默认 GLM-5.2）判定是否达成共识并合成「共识点 / 分歧裁决 / 最终建议」。轮次自适应（达成共识提前收工），全部调用带超时与跨平台降级链。走 OpenAI 兼容免费 API（OpenRouter / 智谱 / 硅基流动 / 魔搭），零成本、零封号风险。

- 依赖：Node 18+；首次使用把技能目录里 `providers.example.json` 复制为 `providers.json` 并填入至少一个平台的 key（**密钥勿提交**）。
- 触发：`/eddy-agentchat-debate`，或对 agent 说「开辩论 / 多模型讨论 / 商议出结论」。
- 详见 [`skills/eddy-agentchat-debate/SKILL.md`](skills/eddy-agentchat-debate/SKILL.md)。

### eddy-agentchat-parallel

多模型并行分发 → 验收 → 合成：裁判把总任务拆成相互独立的子任务，分给不同厂商模型并行执行，逐项验收（不合格自动换模型补发一次再复验），最后由总编合成一份完整交付物（总体结论 / 整合成品 / 遗留问题）。对标 [AgentChat-IndependentTasks](https://github.com/ziwang-Physics/AgentChat) 的编排模式，但走官方 API 而非浏览器自动化。同样支持超时与降级链。

- 依赖：同上。
- 触发：`/eddy-agentchat-parallel`，或对 agent 说「并行分发 / 分工执行 / 汇总成一份方案」。
- 详见 [`skills/eddy-agentchat-parallel/SKILL.md`](skills/eddy-agentchat-parallel/SKILL.md)。

## 贡献

1. 新增 skill：在 `skills/` 下新建 `<eddy-xxx>/SKILL.md`（frontmatter 含 `name` + `description`，正文为 markdown playbook）。
2. 提交 PR 或直接推送到本仓库。

## License

（待定）
