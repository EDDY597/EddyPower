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

## 贡献

1. 新增 skill：在 `skills/` 下新建 `<eddy-xxx>/SKILL.md`（frontmatter 含 `name` + `description`，正文为 markdown playbook）。
2. 提交 PR 或直接推送到本仓库。

## License

（待定）
