# live-sdk 发布到 npm —— 本地操作指引

包名：`@fancaf/live-sdk`　版本：`0.1.0`　发布方式：公开（`publishConfig.access: public`）

---

## 〇、先确认 scope 归属（最容易卡住的一步）

本包是 **scoped 包**（`@fancaf/...`），发布的前提是你**拥有 `@fancaf` 这个 scope**。scope 有两种来源，**都必须在 npm 网站上获得，CLI 无法创建**（`npm org` 只有 `set` / `rm` / `ls` 三个子命令，没有 `create`）。

```bash
npm whoami        # 看你的 npm 用户名 —— 它本身就是一个你独有的 scope
npm org ls fancaf # 查 @fancaf 成员；报 404 说明「组织不存在」或「你不在其中」
```

> 注意：`npm org ls <scope>` 对**不存在的组织**和**你不是成员的组织**都返回 404，无法据此区分。

### 方式 A：用用户名当 scope（推荐，零成本）

每个 npm 用户都**自动拥有**与用户名同名的 scope，无需申请、无需付费、立即生效。

- 若用户名为 `sunlei33`，则 `@sunlei33/live-sdk` 立即可发。
- 切换方式（改包名即可，其他配置不用动）：

```bash
# 把 <username> 换成 npm whoami 的输出
npm pkg set name='@<username>/live-sdk'
```

### 方式 B：创建 Organization 以获得 `@fancaf`

1. 登录 https://www.npmjs.com
2. 右上角头像 → **Add an Organization**，或直接打开 https://www.npmjs.com/org/create
3. **Name 填 `fancaf`** —— 组织名就是 scope 名
4. 选择套餐：**"Unlimited public packages" 免费版**（仅公开包；付费版 $7/人/月 才支持私有包）
5. 点 **Create**，创建者自动成为 Owner

注意事项：

- **组织名全局唯一且不可随意改名**（改名需联系 npm Support），所以务必确认 `fancaf` 没被占用。目前该 scope 下没有任何已发布包，看起来是空闲的。
- 若被他人占用，创建会失败，此时只能换组织名或改用方式 A。
- 若你只是要发包给自己的项目，**方式 A 完全够用**，不必建组织。

---

## 一、一次性准备

```bash
cd D:/dev/m-player/live-sdk
npm adduser          # 登录 npm（浏览器授权）
npm whoami           # 确认登录身份
```

依赖已装好可跳过；换机器则先 `npm ci`。

---

## 二、发布（推荐：用脚本）

```bash
# 1) 先演练一遍：走完校验 + 预览 tarball，不上传
npm run release:dry

# 2) 正式发布
npm run release

# 开了两步验证（2FA）的话，把一次性口令一起传进去
npm run release -- --otp=123456

# CI / 无交互终端：加 --yes 明确确认（否则脚本会拒绝发布）
npm run release -- --yes
```

脚本 `scripts/publish.mjs` 会依次做：

1. **前置检查** —— node/npm、`private` 未开启、`npm whoami` 登录态、scoped 包的 scope 归属、git 工作区与分支
2. **质量门** —— `npm test`（49 条）→ `npm run build` → `npm run verify`（类型契约 + 导出符号 + 运行时冒烟）
3. **预览** —— `npm pack --dry-run`，列出将要上传的每个文件与体积
4. **确认** —— 输入 `y` 才继续
5. **发布** —— `npm publish --ignore-scripts`
6. **（可选）打 tag** —— 询问是否为本次发布创建 `v0.1.0` 并推送到 origin

其他参数：`--skip-gate` 跳过质量门（不推荐）、`--yes` 跳过交互确认、`--help` 查看用法。

> **跨平台**：脚本用 Node 编写（`scripts/publish.mjs`），只依赖 Node 内置模块，**Windows / macOS / Linux 行为完全一致**，不依赖 bash / Git Bash。之所以不是 `.sh`——Windows 下 `.sh` 无法双击或在 cmd / PowerShell 里直接运行。


---

## 三、不用脚本的等价命令

```bash
npm test && npm run build && npm run verify   # 质量门
npm pack --dry-run                            # 预览
npm publish                                   # 裸发布（prepublishOnly 会自动跑质量门兜底）
```

---

## 四、发布后

```bash
npm view @fancaf/live-sdk version             # 验证已上线
npm i @fancaf/live-sdk                        # 消费者安装
```

---

## 五、版本迭代

```bash
npm version patch -m "release: v%s"   # 0.1.0 → 0.1.1（bugfix）
npm version minor -m "release: v%s"   # 0.1.0 → 0.2.0（新功能）
npm version major -m "release: v%s"   # 0.1.0 → 1.0.0（破坏性变更）

git push && git push --tags           # 推代码与 tag
npm run release                       # 再走一遍发布脚本
```

> 注意：`npm version` 会自动创建一次提交和一个 tag。已发布的版本号**不可复用**，即使用 `npm unpublish` 撤回，同一版本号也不能再次发布 —— 撤回后只能发更高版本。

---

## 六、本次随附的配置修正

- **补 `peerDependencies`**：`react>=17` / `vue>=3`（optional）。此前只有 `peerDependenciesMeta` 而无对应 `peerDependencies`，等于没生效，消费者装 `live-sdk/react` 时拿不到版本提示。
- **补 `repository` / `homepage` / `bugs`**：指向 https://github.com/sunlei33/live-sdk。
- **`sideEffects: false`**：入口无 import 期副作用，利于打包器 tree-shaking。
- **`engines.node >= 18`**。
- **`prepublishOnly`** 质量门加入单测。

### 包内容（`npm pack --dry-run` 实测）

| 项 | 值 |
|---|---|
| 文件数 | 75 |
| 打包体积 | 148.8 kB（解开 510.5 kB） |
| 内容 | 仅 `dist/`（JS + `.d.ts` + `.map`）+ 自动包含的 README.md / LICENSE / package.json |

四个子路径入口均含类型声明：`.`、`./ui`、`./react`、`./vue`。
`hls.js` 与 `react` / `vue` 均以外部依赖形式产出（peer/dep 语义正确）。
