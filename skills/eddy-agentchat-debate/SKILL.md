---
name: eddy-agentchat-debate
description: 多模型辩论并合成统一意见。多个跨厂商模型(默认智谱/阿里/阶跃/蚂蚁)就同一议题立论→交锋,旗舰裁判(默认 GLM-5.2)判定共识并合成结论;轮次自适应,超时自动降级。走 OpenAI 兼容免费 API,零成本。触发词:开辩论、多模型讨论、几个AI商议出结论、交叉决策、听多个模型的意见。
---

# 多模型辩论

**首次使用**:把本目录的 `providers.example.json` 复制为 `providers.json`,至少填一个平台的 `apiKey`(密钥勿提交 git)。需 Node 18+。

```bash
cd "<本技能目录>" && node debate.mjs "<用户议题>"
```

参数(均可选):`--rounds=N`(轮数上限,达成共识自动提前结束)、`--timeout=ms`(默认 120000)、`--models=a,b`、`--judge=x`、`--out=xx.md`、`--file=议题.txt`。模型写法 `平台@模型`,平台见 providers.json;`--list` 看 OpenRouter 免费池。

执行规则:命令可能跑几分钟,耐心等完,不要中途取消。结束后只向用户转述最终"统一意见"一节和记录文件路径,不要复述辩论全程。终端出现 `↳ 降级` 行属正常自愈,无需报告。
