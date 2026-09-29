---
name: eddy-agentchat-parallel
description: 多模型并行分发任务,验收后合成一份成品。裁判把总任务拆成独立子任务,分给不同厂商模型并行执行,逐项验收(不合格自动换模型补发),最后合成完整交付物。对标 AgentChat-IndependentTasks,走官方免费 API。触发词:并行分发、拆分任务给多个AI、分工执行、多模型各干一块再汇总、生成多部分的方案/报告。
---

# 并行分发

**首次使用**:把本目录的 `providers.example.json` 复制为 `providers.json`,至少填一个平台的 `apiKey`(密钥勿提交 git)。需 Node 18+。

```bash
cd "<本技能目录>" && node parallel.mjs "<用户总任务>"
cd "<本技能目录>" && node parallel.mjs --tasks="子任务1|子任务2|子任务3" "<总目标>"   # 用户已明确子任务时
```

参数(均可选):`--split=N`(拆解数量)、`--timeout=ms`(默认 120000)、`--workers=a,b`、`--judge=x`、`--out=xx.md`。

执行规则:命令可能跑几分钟,耐心等完,不要中途取消。结束后只向用户转述"总编收尾"的总体结论与遗留问题,附记录文件路径;子任务明细让用户自己翻记录。终端出现 `↳ 降级` 行属正常自愈,无需报告。
