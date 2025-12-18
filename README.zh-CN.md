# Blinko to obsidian

[English](./README.md) | **简体中文**

**Blinko to obsidian** 是一个 Obsidian 社区插件，旨在将自托管的 [Blinko](https://github.com/blinko-space/blinko) 闪念笔记服务与您的本地知识库无缝连接。

它可以将你在 Blinko 中记录的碎片化想法（Flash）、笔记（Note）和待办（Todo）及其附件自动同步到 Obsidian 中，支持增量同步、AI 自动生成标题以及将闪念笔记嵌入到你的“日记（Daily Note）”中。

## ✨ 主要功能

- **增量同步**：智能记录上次同步时间，仅拉取新增或更新的笔记，速度快且节省流量。
- **附件自动下载**：自动识别笔记中的图片、音频等附件，下载到本地指定文件夹，并将链接转换为 Obsidian 本地链接格式（`![[file]]`）。
- **日记（Daily Note）集成**：支持将当天的闪念笔记自动插入到你 Obsidian 日记文件的指定区域内，方便回顾。
- **AI 智能标题**：针对通常没有标题的“闪念笔记”，支持调用 OpenAI 格式的 API（如 GPT-4o-mini）根据内容自动生成简练的标题。
- **高度自定义路径**：支持使用模板变量自定义笔记的文件名和存储路径（例如按类型分类存储）。
- **双向删除同步**：支持检测 Blinko 端已删除（或移入回收站）的笔记，并自动从 Obsidian 本地删除对应的文件和附件，保持库的整洁。
- **Frontmatter 元数据**：自动添加详细的 YAML Frontmatter，包含标签、创建时间、类型等信息，方便 Dataview 查询。

## ⚠️ 重要注意事项（必读）

> [!DANGER] **关于数据修改的警告** **这是一个单向同步工具（Blinko -> Obsidian）。**
>
> 请**不要**直接在 Obsidian 中修改由插件生成的 `blinko-*.md` 文件内容。
>
> - 如果你在 Obsidian 修改了这些文件，一旦你在 Blinko 服务端更新了该条笔记，插件在下次同步时会**覆盖**掉你在本地的修改。
> - 如需修改笔记内容，请务必在 Blinko 服务端进行。
> - 如果你想基于 Blinko 笔记进行长文写作，建议使用“引用”或“复制”的方式，在另一个新的 Obsidian 笔记中进行。

## ⚙️ 安装与配置

### 1. 安装插件

目前请通过手动安装或 BRAT 插件安装（如果尚未上架社区市场）：

1. 下载 Release 中的 `main.js`, `manifest.json`, `styles.css`。
2. 放入 `.obsidian/plugins/blinko-sync/` 文件夹中。
3. 在设置中启用插件。

### 2. 基础配置

进入 **Settings (设置) -> Blinko Sync**：

- **Server Connection (服务器连接)**:
  - **Server URL**: 填写你的 Blinko 部署地址 (例如 `https://my-blinko.com`，无需加 `/api`)。
  - **Access Token**: 在 Blinko 设置中生成的 API Token。
- **Storage (存储设置)**:
  - **Note folder**: 存放同步下来的笔记的根目录（例如 `Blinko/Notes`）。
  - **Attachment folder**: 存放图片/音频的目录（例如 `Blinko/Attachments`）。

### 3. 功能详细配置指南

#### 📂 文件名与路径模板

你可以自定义笔记保存的文件名格式。

- **File Name Template**: 默认为 `{{typeFolder}}/blinko-{{id}}`。
  - 这会自动将笔记按类型存放在子文件夹中，如 `Blinko/Notes/Flash/blinko-123.md`。
- **可用变量**:
  - `{{id}}`: 笔记 ID (必须包含以确保唯一性)。
  - `{{type}}`: 类型名称 (flash, note, todo)。
  - `{{typeFolder}}`: 类型文件夹 (Flash, Note, Todo)。
  - `{{title}}`: 笔记标题（如果是 Flash 笔记则尝试截取内容第一行）。
  - `{{aiTitle}}`: 如果启用了 AI，使用 AI 生成的标题。
  - `{{created:YYYY-MM-DD}}`: 创建日期。

#### 📅 Daily Note (日记) 集成

将当天的闪念笔记自动同步到你的日记文件中。

1. **启用开关**: 打开 "Enable Daily Notes integration"。

2. **定位日记**:

   - **Location**: 日记所在的文件夹（例如 `Daily`）。
   - **Format**: 日记文件名的日期格式（例如 `YYYY-MM-DD`）。

3. **设置插入锚点**: 插件需要知道把内容插在日记的哪里。请在你的日记模板中添加以下两行 HTML 注释：

   ```
   <MARKDOWN>
   
   <!-- start of flash-notes -->
   
   <!-- end of flash-notes -->
   ```

   插件会自动将内容填充到这两行之间。

#### 🤖 AI 标题生成 (可选)

让你的文件列表更直观，而不是全是 `blinko-123`。

1. **启用开关**: 打开 "Enable AI Title Generation"。
2. **API 设置**:
   - **Base URL**: 例如 `https://api.openai.com/v1` (也支持第三方转发)。
   - **API Key**: 你的 API 密钥。
   - **Model**: 模型名称，推荐 `gpt-4o-mini` 或其他快速且便宜的模型。
3. **效果**: 当同步一条没有标题的 Flash 笔记时，AI 会读取内容并生成一个不超过 15 个词的简短标题用于文件名或 Frontmatter。

#### 🗑️ 删除同步

- **Delete Check**: 开启后，插件会定期检查本地文件是否在服务器上依然存在。
- **Sync Deletions**: 如果服务器上删除了笔记，本地对应的 `.md` 文件和**专属附件**也会被删除。
- **Recycle Bin**: 可选择是否同步删除那些还在 Blinko 回收站里的笔记。

------

## 使用指南

1. **手动同步**:
   - 点击左侧边栏的 Blinko 图标。
   - 或者 `Ctrl/Cmd + P` 呼出命令面板，搜索 `Blinko: Sync now`。
2. **自动同步**:
   - 在设置中调整 `Auto sync interval`（自动同步间隔），默认为 30 分钟。设为 0 可关闭。
3. **查看结果**:
   - 同步完成后，Obsidian 右上角会弹出提示，告知新增了多少条笔记。