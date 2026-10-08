# dsh-plugin-session-purge

**两步删除会话。** DSH 只会归档会话 —— `dsh-client-ui-workspace` 的 README 明写 *"No Session deletion — sessions can be archived but never deleted"*；这个插件补上删除。

## 入口

| 入口 | 位置 | 谁用 |
|---|---|---|
| 会话「…」菜单里的一行 **放入回收站**（order 500，排在归档之后） | 侧栏任意会话行 | 人 |
| 侧栏底部 **回收站** 入口（带待删数量） | 侧栏页脚，Settings 旁 | 人 |

只有一个入口、**没有 agent 工具**：模型不能自己删会话，只有你手点才会发生。

## 删什么

按会话分别清掉三处：

1. **工作区登记** —— 每个 Workspace 的 `sessionIds`、全局的归档集合与置顶集合。走 WorkspaceRegistry / WorkspaceHandle.detachSession 自己的 API 写，**不由插件直接改** workspace.json。
2. **投影缓存** —— 走 storage domain 自己的表（`session_projcache` / `sessions`）的 `delete`，内存表与磁盘文档一起掉。
3. **会话目录** —— 会话存储根下的 `<项目键>/<会话 id>/`，里面是压缩后的会话日志全部世代。

会话存储根取 `sessionPersistence.root`（JSONL 后端配置的那个），取不到就退回 `DSH_HOME/sessions`；**两个都取不到就拒绝删除**，不猜路径。

## 不删什么

- **附件字节**：内容寻址、多个会话共用同一份，删了会连累别的会话。
- **搜索索引**：派生数据，自己按 persistence 列表对账，看得见日志消失就删行。

## 安全闸门

- 一次调用要删的集合里包含**它自己所在的会话** → 拒绝。
- 会话存储根解析不出来 → 拒绝，不猜路径。
- 会话在进程里**活着**（有窗格开着、正在跑、被 agent 持有）不会被拒绝，而是**先停掉它的工作、再驱逐宿主内存里的条目**，然后才动文件 —— 不然 Windows 上写句柄一直挂到进程退出，文件根本删不掉。`plan` 会把每个目标的 `live` 标出来。
- 界面上点「放入回收站」先取 `plan`（要删的目录清单 + 会连带删掉的子代理会话数），确认框里展示，再走 `move`。

**子代理会话**：`origin: "subagent"` 的**隐藏后代**（侧栏本来就看不到、父会话没了就再也够不着）默认**一起删**，可在确认框里取消勾选；**可见的 fork 子会话永远不连带**。

**取消勾选之后留下的那些**：它们没有侧栏行，父会话的确认框又是唯一会点名它们的地方 —— 父会话一旦离开会话根，界面上就再没有入口。所以回收站面板里单独有一节 **「孤儿子代理会话 (N)」**，逐个「放入回收站」。判定只有两条：`origin === 'subagent'`，且它的 `parentSession` 不在会话根清单里（父被真删、父在回收站里，都表现为"不在清单里"，所以不需要第三种判定）。走的完全同一套语义：先入回收站、下次启动真删、随时可恢复（恢复后它依旧是隐藏的，没有行）。

## 实现要点

- **投影缓存只读两处，且是同一个方法**：`restoredProjections(header)` —— ① 恢复回执里带上 `title` / `sessionListMetadata`（恢复瞬间标题就正常）；② 回收站面板的列表里，给**回收站每一行**与**每个孤儿子代理行**附上 `title`。两处都只走缓存自己的 `cachedSnapshot(header, [...])` 只读面、只问已知键、**从不写、从不种**；取不到（服务缺失 / 无记录 / 读抛错 / 日志头读不出）一律留空 `title: ''`，面板随即回落显示**会话 id**（有标题时 id 仍作为灰色小字显示）。**除这两处之外没有任何代码读投影缓存。**
- **宿主半边**注册一条精确 Fetch 路由 `api/session-purge`（挂在已就绪的 `/api` 载体上），端点五个：`plan`（只出清单）· `move`（放进回收站）· `list`（回收站 + 孤儿子代理清单 + 各自的标题）· `restore`（移回原位）· `empty`（立刻真删）。走这条载体意味着**鉴权（Host/Origin 校验 + 浏览器 cookie）在进入处理函数之前就已完成**。
- **客户端半边**注册两处：会话「…」菜单一行（`sidebar.workspaces.session.menu.item`，order 500）+ 一个浮层确认框（`shell.overlay`）。只 `require('react')`，不加载任何 Harness 客户端包；颜色只用 `--dsw-alias-*` 主题 token（带字面量回退），token 改名只会掉色、不会坏。

## 两段式删除

1. **放入回收站**（点菜单那一刻）：停掉该会话的工作 → 驱逐宿主内存里的条目 → **摘掉工作区成员名单**（这一条才是让侧栏那行消失的开关）→ 把**整个会话目录**移进回收站。
   此阶段**不删任何字节**，也不碰归档 / 置顶 / 投影缓存。
2. **真正删除**（下次启动 DSH 时）：扫描回收站 → 逐个删除目录 + 投影缓存 + spill 溢出文件 + 工作区成员名单 + 归档 / 置顶集合，并清掉本页那些带该会话 id 的持久键。

回收站里清单的**唯一来源就是目录本身**（会话 id 是目录名，原项目目录是上一层），所以没有任何清单文件或旁挂元数据。恢复 = 把目录移回去，`cwd` 从会话自己的日志头里读回来，会话回到原工作区。

**位置**：`<DSH_HOME>\session-purge-trash\<项目目录>\<会话id>\`（`DSH_HOME` 默认 `~/.dsh`）。

**卸载前请先清空回收站**（面板里的「清空回收站」就是立刻真删）。卸载后没有任何代码在跑，回收站只能手动处理：删掉目录 = 真删；把里面的会话目录移回 `<DSH_HOME>\sessions\<同一个项目目录>\` = 恢复。

## 安装

**填仓库地址就够了** —— 在 DSH 的 **插件 → 添加插件** 里粘进这一行（那一步接受"包名 / GitHub 仓库地址 / 本地目录路径"三种输入，这里用仓库地址）：

```
https://github.com/OliYogSothoth/dsh-plugin-session-purge
```

命令行等价写法：

```
dsh plugin --profile web add github:OliYogSothoth/dsh-plugin-session-purge
```

装完**重启 Harness**。这条路会把包**复制一份**进 profile ⇒ **你不需要保留任何本地目录**。

> 目前只在 GitHub 上（还没有 npm 包名）。

### 本地目录安装（自己改源码时才用）

只有**你改了源码、要让改动立刻生效**才走这条路：它用 pnpm 的 `link:`，profile 里只指向你的源码目录。所以先把那个"本地路径"从哪来说清楚：

1. **把仓库拿到本地**（这一步才产生"本地目录"）：
   ```
   git clone https://github.com/OliYogSothoth/dsh-plugin-session-purge
   ```
2. **把 clone 出来的那个目录的绝对路径**填进「插件 → 添加插件 → 本地目录路径」（或等价的 `plugin_manager → install_bundle → target: <该路径>`），例如：
   ```
   C:\Users\你\Documents\dsh-plugin-session-purge
   ```

> ⚠️ **只有这条路需要源码目录长期留着**：包的内容**不会**被复制进 profile，删掉目录插件就失效。
> 改完怎么生效：`client.js` **刷新页面**即可；`host.js` **必须重启 Harness**（同名重装不生效）。

## 卸载

```
plugin_manager → remove_bundle → target: dsh-plugin-session-purge
```

只解除挂载；**不会**回滚已经删掉的会话。

## 文件

| 文件 | 作用 |
|---|---|
| `host.js` | 宿主半边：精确路由（`plan` / `move` / `list` / `restore` / `empty`） |
| `client.js` | 浏览器半边：菜单行 + 确认框 + 回收站面板 + 结果提示 |
| `cordis.patch.yml` | bundle patch：插入本插件这一行 |
| `locale/zh.json` · `locale/en.json` | 插件页卡片上的标题与说明 |
| `icon.svg` | 插件页图标 |
