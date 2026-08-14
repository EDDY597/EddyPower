---
name: eddy-word-headings
description: 把 Word/WPS .docx 文档的标题 1~4 统一为规范的多级列表编号（支持 一/1./1.1/1.1.1 等格式），解决标题编号不联动、需手动「重新编号」、重新编号后自动缩进等问题。触发词：标题统一化、标题规范化、多级列表、标题编号、编号乱、目录编号、heading normalize。
---

# normalize-word-headings：Word 标题多级列表统一化

> 只改标题的「编号（多级列表）+ 编号相关缩进」，不动正文文字（唯一例外：删除标题里手打的编号前缀，如「一 测试背景」里的「一 」）。适用于 WPS / MS Word 的 `.docx`（`.doc` 先另存为 `.docx`）。

## 核心原理（为什么会有那两个问题）

Word 里标题编号必须靠「多级列表」（numbering.xml 里 `multiLevelType` 为 multilevel/hybridMultilevel）。用户常见的病根是：
1. **标题 2/3/4 各绑了独立的「单级列表」**（`singleLevel`），各编各的 → 3 级标题不跟随 2 级标题，序号接着上一个往下排，所以「新建 3 级标题序号不是 1」。
2. **列表级别自带的缩进（`w:ind`）与段落样式缩进不一致** → 点「重新编号」时列表缩进覆盖样式缩进，所以「重新编号后自动缩进」。

根治法：把标题 1~4 绑到**同一个多级列表**的 1~4 级，每级「在上级后自动重启」（多级列表默认行为），并让**列表缩进与样式缩进完全一致**（统一用悬挂缩进，或全部归零）。

## 第 0 步：决策（必须 ask，不瞎猜）

动手前向用户确认 3 点（用 ask 工具，一次问清）：
1. **目标文档**完整路径；有多个候选（初版/日期后缀/最新版）时确认「正在编辑的最新那个」。
2. **编号格式**：标题 1~4 各显示成什么。常见三种：
   - 标准：`1 / 1.1 / 1.1.1 / 1.1.1.1`
   - 中文章节：`一 / 1.1 / 1.1.1 / 1.1.1.1`
   - 自定义：如 `一 / 1. / 1.1 / 1.1.1`（标题1 中文、标题2 只显本级、标题3 起才带上级）
3. **标题 1 是否自动编号**（若原先是手打「一、二、三…」需删除这些字）。

## 第 1 步：诊断（读 docx 的 XML，不依赖 WPS）

docx 就是 zip。用 python 读 3 个 XML：

```python
import zipfile, re
p = r'<目标文档路径>'
z = zipfile.ZipFile(p)
styles = z.read('word/styles.xml').decode('utf-8')
numbering = z.read('word/numbering.xml').decode('utf-8')
document = z.read('word/document.xml').decode('utf-8')
```

关键事实：
- **标题样式 styleId 映射**（中文 Word/WPS 内置）：`2`=标题1，`3`=标题2，`4`=标题3，`5`=标题4（`1`=Normal）。
- styles.xml 里看标题样式的 `numPr`（绑定的 `numId`/`ilvl`）和 `ind`。
- numbering.xml 里看每个 `abstractNum` 的 `multiLevelType`（singleLevel=单级/独立；multilevel 或 hybridMultilevel=多级）和每个 `lvl` 的 `numFmt`、`lvlText`、`pStyle`、`ind`。
- document.xml 里遍历段落，找 `pStyle` 是 2/3/4/5 的段落，看它们的段落级 `numPr` 覆盖和 `<w:t>` 文本（识别手打编号）。
- 判读结论：标题用了几个独立的 `numId`？各自 `multiLevelType`？列表 `ind` 与样式 `ind` 是否一致？手打编号长什么样？

## 第 2 步：改造（建立多级列表 + 绑定标题 + 清覆盖）

### 2.1 编号格式 → 每级 XML 的映射

多级列表每级的编号由 `numFmt` + `lvlText` 决定，`%N` 引用第 N 级的计数：

| 标题 | 标准 1/1.1/1.1.1 | 中文章节 一/1.1/1.1.1 | 一/1./1.1/1.1.1 |
|---|---|---|---|
| 标题1(ilvl0) | `decimal` `"%1"` | `chineseCounting` `"%1"` | `chineseCounting` `"%1"` |
| 标题2(ilvl1) | `decimal` `"%1.%2"` | `decimal` `"%1.%2"` | `decimal` `"%2."` |
| 标题3(ilvl2) | `decimal` `"%1.%2.%3"` | `decimal` `"%1.%2.%3"` | `decimal` `"%2.%3"` |
| 标题4(ilvl3) | `decimal` `"%1.%2.%3.%4"` | `decimal` `"%1.%2.%3.%4"` | `decimal` `"%2.%3.%4"` |

- `chineseCounting` 生成「一、二、三…」。
- **编号与文字之间要一个空格**：把空格直接写进 `lvlText`（尾随半角空格，如 `%1 `、`%2. `、`%2.%3 `、`%2.%3.%4 `），并设 `suff="nothing"`。这样**正文和左侧导航窗格都显示空格**。注意：若用 `suff="space"` 只在正文显示空格，**导航窗格不显示**，会让用户误以为没空格。
- 缩进统一用**悬挂缩进**（编号逐级右移一格），并同步到样式，彻底消灭「重新编号乱缩进」：`ilvl0 left=0 hanging=0`；`ilvl1 left=425 hanging=425`；`ilvl2 left=850 hanging=425`；`ilvl3 left=1275 hanging=425`（单位 twip，425≈0.75cm）。

### 2.2 三个 XML 的修改点

**numbering.xml**：在 `</w:numbering>` 前插入一个 `abstractNum`（`multiLevelType=hybridMultilevel`，4 个 `lvl` 各带 `pStyle` 绑定样式 2/3/4/5）和一个引用它的 `num`（取文档里未占用的 `abstractNumId`/`numId`，例如 6/8）。

**styles.xml**：把标题 1~4 样式的 `numPr` 改成指向新 `numId` 的对应 `ilvl`（标题1 若无 numPr 则插入）；把标题 3/4 的 `firstLine` 缩进改成悬挂缩进。

**document.xml**：对每个标题段落（`pStyle` 为 2/3/4/5）：删除段落级 `numPr`（`<w:numPr>.*?</w:numPr>`，让段落继承样式）；标题 1 段落再删除 `<w:t>` 开头的手打编号前缀（`^[一二三四五六七八九十] `）。

### 2.3 通用改造脚本模板（改 3 处即可用）

```python
import zipfile, re, shutil, datetime
SRC = r'<源文件绝对路径>'
DST = r'<输出文件绝对路径>'
NUM_ID, ABS_ID, NSID = '8', '6', '5A7B3C9D'
LVLS = [
    ('chineseCounting', '%1 '),       # ilvl0 标题1（尾随空格，导航窗格也显示）
    ('decimal',        '%2. '),       # ilvl1 标题2
    ('decimal',        '%2.%3 '),     # ilvl2 标题3
    ('decimal',        '%2.%3.%4 '),  # ilvl3 标题4
]
INDS = ['0','425','850','1275']  # 每级 left；hanging 0级=0 其余=425

def build_lvls():
    s = ''
    for i, (fmt, txt) in enumerate(LVLS):
        left, hang = INDS[i], ('425' if i > 0 else '0')
        s += f'<w:lvl w:ilvl="{i}" w:tentative="0"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:pStyle w:val="{i+2}"/><w:suff w:val="nothing"/><w:lvlText w:val="{txt}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{left}" w:hanging="{hang}"/></w:pPr></w:lvl>'
    return s

ABSTRACT = f'<w:abstractNum w:abstractNumId="{ABS_ID}"><w:nsid w:val="{NSID}"/><w:multiLevelType w:val="hybridMultilevel"/><w:tmpl w:val="{NSID}"/>{build_lvls()}</w:abstractNum><w:num w:numId="{NUM_ID}"><w:abstractNumId w:val="{ABS_ID}"/></w:num>'

zin = zipfile.ZipFile(SRC)
items = {i.filename: zin.read(i.filename) for i in zin.infolist()}
zin.close()
num = items['word/numbering.xml'].decode('utf-8').replace('</w:numbering>', ABSTRACT + '</w:numbering>')
st  = items['word/styles.xml'].decode('utf-8')
st = st.replace('<w:ind w:firstLine="400" w:firstLineChars="0"/>', '<w:ind w:left="850" w:hanging="425"/>')
st = st.replace('<w:ind w:firstLine="1767" w:firstLineChars="400"/>', '<w:ind w:left="1275" w:hanging="425"/>')
doc = items['word/document.xml'].decode('utf-8')
def proc(p):
    m = re.search(r'<w:pStyle w:val="([0-9]+)"', p)
    if not m or m.group(1) not in ('2','3','4','5'): return p
    p = re.sub(r'<w:numPr>.*?</w:numPr>', '', p, flags=re.S)
    if m.group(1) == '2':
        p = re.sub(r'(<w:t[^>]*>)([^<]*)</w:t>', lambda mm: mm.group(1) + re.sub(r'^[一二三四五六七八九十] ', '', mm.group(2)) + '</w:t>', p)
    return p
doc = re.sub(r'<w:p\b.*?</w:p>', proc, doc, flags=re.S)
shutil.copy2(SRC, SRC.replace('.docx', f'_备份_{datetime.datetime.now():%Y%m%d_%H%M%S}.docx'))
items['word/numbering.xml'] = num.encode('utf-8')
items['word/styles.xml']   = st.encode('utf-8')
items['word/document.xml'] = doc.encode('utf-8')
with zipfile.ZipFile(DST, 'w', zipfile.ZIP_DEFLATED) as zo:
    for name in items: zo.writestr(name, items[name])
print('done ->', DST)
```

> 注意：上面 styles.xml 的 numPr 替换只是示意，实际要先诊断确认每个标题样式原 `numPr` 的精确字符串再 `replace`（标题 1 若无 numPr 需在 `<w:outlineLvl w:val="0"/>` 前插入），不要全局正则误伤。生成后必须重新解压新 docx 校验 `numPr`/`ind`。

### 2.4 间距规范化（正文 + 标题 2~4）

常见要求：正文（Normal）和标题 2/3/4 的**段前段后 = 0、单倍行距**（标题 1 通常保留较大段距，不动）。

只改 styles.xml 里这几个样式的 `<w:spacing>`，统一替换为 `<w:spacing w:before="0" w:after="0"/>`（`before=0` 段前 0、`after=0` 段后 0、无 `w:line` = 单倍行距）：

| 样式 | 典型原 spacing | 改成 |
|---|---|---|
| Normal(正文) | `before=100 beforeLines=100 after=100 afterLines=100` | `before=0 after=0` |
| 标题2 | `beforeLines=0 afterLines=0 line=360 lineRule=auto`（=1.5 倍） | `before=0 after=0` |
| 标题3 | `line=240 lineRule=auto`（已单倍） | `before=0 after=0` |
| 标题4 | `beforeLines=0 afterLines=0` | `before=0 after=0` |

- 行距倍数 = `w:line` / 240：`line=360`=1.5 倍、`line=240`=单倍。要单倍就**删掉 `w:line`**（或 `line=240 lineRule=auto`）。
- `w:beforeLines`/`w:afterLines` 是「按行」段距（100=1 行），`w:before`/`w:after` 是「按磅」（单位 twip，20=1 磅）。要 0 就都删或设 0。
- 正文段落常带 direct formatting（document.xml 里段落级 `<w:spacing>`），若已设 0 不用动；关键是改样式，让没有覆盖的段落也归 0。

## 第 3 步：验证（WPS 渲染实测，唯一可信）

用独立 WPS COM 实例打开**新文件**（不要碰用户正在编辑的实例），读每个标题段落的 `ListFormat.ListString` 验证编号、`ListLevelNumber` 验证级别：

```powershell
$word = New-Object -ComObject 'Kwps.Application'
$doc = $word.Documents.Open('<新文件路径>')
for ($i=1; $i -le $doc.Paragraphs.Count; $i++) {
  $p = $doc.Paragraphs.Item($i)
  if ($p.Style.NameLocal -match '标题 ?[1-4]') {
    Write-Output ($p.Range.ListFormat.ListString + ' | ' + $p.Range.ListFormat.ListLevelNumber + ' | ' + $p.Range.Text)
  }
}
$doc.Close($false); $word.Quit()
```

预期：标题1 显示 一/二/三…；标题2 在每个标题1 下从 1 重启；标题3 在每个标题2 下从 `.1` 重启；标题4 同理。再 `ExportAsFixedFormat(..., 17)` 导出 PDF，用 pymupdf 看标题 x 坐标确认缩进逐级递增（425/850/1275 twip）。

## 第 4 步：落地（备份 + 替换 + 重开）

1. 新文件独立命名（如 `..._多级列表.docx`）验证通过后再替换。
2. 若目标文档正被 WPS 打开，文件会**被独占锁定**（`open(path,'r+b')` 报 PermissionError）。必须让用户先在 WPS 里**保存并关闭**该文档，再覆盖。
3. 覆盖后用 `subprocess.Popen(['explorer', path])` 重新打开（WPS COM 的 `Documents.Open` 在多实例下不可靠）。

## 关键坑（务必遵守）

- 只动编号与编号缩进，**不碰正文**；手打编号前缀只删标题段落里的「一 ~ 十 + 空格」。
- 段落级 `numPr` 覆盖必须清干净（否则某段仍指向旧单级列表）。
- 列表缩进与样式缩进**必须一致**，否则「重新编号」又会乱缩进。
- 标题2 默认会在每个标题1 下重新从 1 编号（多级列表标准行为）；若用户要「全文档连续」，需另设（rare）。
- 中文路径/脚本：PowerShell 脚本用 `encoding='utf-8-sig'`（UTF-8 BOM）生成，否则 GBK 解码乱码。
- 改完必须完整校验 + 让用户目视确认，不要只信 XML 判断。
