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

- 会话在进程里**活着**（有窗格开着、正在跑、被 agent 持有）→ 拒绝，并列出是哪些。
- 一次调用要删的集合里包含**它自己所在的会话** → 拒绝。
- 界面上点「彻底删除」先取 `plan`（要删的目录清单 + 会连带删掉的子代理会话数），确认框里展示，再走 `delete`。

**子代理会话**：`origin: "subagent"` 的**隐藏后代**（侧栏本来就看不到、父会话没了就再也够不着）默认**一起删**，可在确认框里取消勾选；**可见的 fork 子会话永远不连带**。

## 实现要点

- **宿主半边**注册一条精确 Fetch 路由 `api/session-purge`（挂在已就绪的 `/api` 载体上），两个端点：`plan`（只出清单）与 `delete`（真删）。走这条载体意味着**鉴权（Host/Origin 校验 + 浏览器 cookie）在进入处理函数之前就已完成**。
- **客户端半边**注册两处：会话「…」菜单一行（`sidebar.workspaces.session.menu.item`，order 500）+ 一个浮层确认框（`shell.overlay`）。只 `require('react')`，不加载任何 Harness 客户端包；颜色只用 `--dsw-alias-*` 主题 token（带字面量回退），token 改名只会掉色、不会坏。

## 两段式删除

1. **放入回收站**（点菜单那一刻）：停掉该会话的工作 → 驱逐宿主内存里的条目 → **摘掉工作区成员名单**（这一条才是让侧栏那行消失的开关）→ 把**整个会话目录**移进回收站。
   此阶段**不删任何字节**，也不碰归档 / 置顶 / 投影缓存。
2. **真正删除**（下次启动 DSH 时）：扫描回收站 → 逐个删除目录 + 投影缓存 + spill 溢出文件 + 工作区成员名单 + 归档 / 置顶集合，并清掉本页那些带该会话 id 的持久键。

回收站里清单的**唯一来源就是目录本身**（会话 id 是目录名，原项目目录是上一层），所以没有任何清单文件或旁挂元数据。恢复 = 把目录移回去，`cwd` 从会话自己的日志头里读回来，会话回到原工作区。

**位置**：`<DSH_HOME>\session-purge-trash\<项目目录>\<会话id>\`（`DSH_HOME` 默认 `~/.dsh`）。

**卸载前请先清空回收站**（面板里的「清空回收站」就是立刻真删）。卸载后没有任何代码在跑，回收站只能手动处理：删掉目录 = 真删；把里面的会话目录移回 `<DSH_HOME>\sessions\<同一个项目目录>\` = 恢复。
## 从 GitHub 安装

在 DSH 的「添加插件」里填入仓库地址即可（不需要 npm 账号）：

```
https://github.com/OliYogSothoth/dsh-plugin-session-purge
```

装完重启 Harness。源码就在这个仓库里，改完重新装或直接刷新页面即可看到客户端改动（宿主改动需重启）。
## 安装

```
plugin_manager → install_bundle → target: <本包目录的绝对路径>
```

等价于界面上的「插件 → 添加插件 → 本地目录路径」。

> ⚠️ **源码目录要长期留着**：本地目录安装走的是 pnpm 的 `link:` 依赖 —— 包的内容**不会**被复制进 profile，profile 里只是指向这个目录；删掉它，插件即失效。（从 npm 包名 / GitHub 安装则是复制一份，没有这个约束。）

## 卸载

```
plugin_manager → remove_bundle → target: dsh-plugin-session-purge
```

只解除挂载；**不会**回滚已经删掉的会话。

## 文件

| 文件 | 作用 |
|---|---|
| `host.js` | 宿主半边：精确路由（`plan` / `delete`） |
| `client.js` | 浏览器半边：菜单行 + 确认框 + 结果提示 |
| `cordis.patch.yml` | bundle patch：插入本插件这一行 |
| `locale/zh.json` · `locale/en.json` | 插件页卡片上的标题与说明 |
| `icon.svg` | 插件页图标 |
