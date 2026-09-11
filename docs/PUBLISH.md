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

## 二、满足 2FA 要求（首次发布必读）

npm 规定：**发布 scoped 公开包，必须满足二者之一** ——
① 账号已启用 2FA，或 ② 使用带 **"Bypass two-factor authentication"** 的 Granular Access Token。

不满足时报错：

```
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/@<scope>%2f<pkg>
npm error - Two-factor authentication or granular access token with bypass 2fa enabled
         is required to publish packages.
```

先查自己的状态：

```bash
npm profile get          # 看 "two-factor auth:" 一行
```

另一种常见失败是 token 权限选成了 `stage only`（报错文案不同，见**情况 C**）。

下面按你的账号状态对号入座：

### 情况 A：`two-factor auth: disabled`（无 2FA）

此时**没有认证器可生成 OTP**，`--otp=` 方案无法使用，**只能走 Granular Access Token**：

1. 打开 https://www.npmjs.com/settings/sunlei33/tokens → **Generate New Token** → 选 **Granular Access Token**
2. 关键配置：
   - **Packages and scopes → Permissions** → 必须选 **`Read and write (publish and stage)`**
     ⚠️ 切勿选 **`Read and write (stage only)`** —— 那只能暂存、不能直接发布（见情况 C）
   - **Bypass two-factor authentication** → ✅ **必须勾选**（这是 403 的解药）
   - Scope 选中你的 `@<scope>`；Expiration / Allowed IP ranges 按需
3. Generate Token 后**立即复制**（只显示一次）
4. 写入 npm 配置（覆盖掉 `npm login` 留下的那个无 bypass 权限的 token）：

```bash
npm config set //registry.npmjs.org/:_authToken=<你的token>
```

> 该 token 等同密码，切勿提交到仓库。若想避免落盘，可改用环境变量：
> 在项目 `.npmrc` 写 `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`，发布前 `export NPM_TOKEN=...`。

#### Permissions 四个选项的区别（npm 官方语义）

| 选项 | 能否直接发布 | 说明 |
|---|---|---|
| No access | ❌ | 无包权限 |
| Read-only | ❌ | 只能读 |
| **Read and write (publish and stage)** | ✅ | **首发/日常发布选这个** |
| Read and write (stage only) | ❌ | 只能暂存，需另一位**开了 2FA** 的维护者批准才能上线 |

### 情况 B：已启用 2FA

每次发布会需要一枚 6 位 OTP。**不要**把 OTP 传给 `--otp` 后干等——TOTP 只有 30 秒有效期，而质量门要跑 40 秒以上，等轮到时早已过期。

正确做法：**直接 `npm run release`**，脚本会在真正执行 `npm publish` 的前一刻提示你输入 OTP。

### 情况 C：报「Stage-only tokens cannot publish new package versions directly」

```
Stage-only tokens cannot publish new package versions directly. Versions must be staged
with `npm stage publish` and then promoted by a maintainer with two-factor authentication
(2FA) enabled. This token can still deprecate versions, move dist-tags, and unpublish.
```

**原因**：建 GAT 时 Permissions 选了 `Read and write (stage only)`。

**解决**：token 的权限**不可修改**，必须**重新生成**一个，Permissions 改选
`Read and write (publish and stage)`，然后 `npm config set //registry.npmjs.org/:_authToken=<新token>`。

**不要试图改走暂存流程** —— staged publishing 要求「包**已经存在**于 registry」，
全新包无法暂存；而且批准环节本身就要求 2FA（你还没开）。所以首次发布必须走直接发布。

---

## 三、发布（推荐：用脚本）

```bash
# 1) 先演练一遍：走完校验 + 预览 tarball，不上传
npm run release:dry

# 2) 正式发布
npm run release

# CI / 无交互终端：加 --yes 明确确认（否则脚本会拒绝发布）
npm run release -- --yes

# 已开 2FA 时不要预先传 --otp（质量门耗时会让口令过期），
# 脚本会在 publish 前一刻提示输入；仅自动化场景才用：
npm run release -- --otp=123456
```

脚本 `scripts/publish.mjs` 会依次做：

1. **前置检查** —— node/npm、`private` 未开启、`npm whoami` 登录态、scoped 包的 scope 归属、git 工作区与分支
2. **质量门** —— `npm test`（49 条）→ `npm run build` → `npm run verify`（类型契约 + 导出符号 + 运行时冒烟）
3. **预览** —— `npm pack --dry-run`，列出将要上传的每个文件与体积
4. **确认** —— 输入 `y` 才继续
5. **发布** —— `npm publish --ignore-scripts`
6. **2FA 失败时给诊断** —— 识别 403/2FA 报错：账号无 2FA 时直接给 GAT 配置步骤；有 2FA 时当场索要 OTP 并立即重试（见第二节）
7. **（可选）打 tag** —— 询问是否为本次发布创建 `v0.1.0` 并推送到 origin

其他参数：`--skip-gate` 跳过质量门（不推荐）、`--yes` 跳过交互确认、`--help` 查看用法。

> **跨平台**：脚本用 Node 编写（`scripts/publish.mjs`），只依赖 Node 内置模块，**Windows / macOS / Linux 行为完全一致**，不依赖 bash / Git Bash。之所以不是 `.sh`——Windows 下 `.sh` 无法双击或在 cmd / PowerShell 里直接运行。


---

## 四、不用脚本的等价命令

```bash
npm test && npm run build && npm run verify   # 质量门
npm pack --dry-run                            # 预览
npm publish                                   # 裸发布（prepublishOnly 会自动跑质量门兜底）
```

---

## 五、发布后

```bash
npm view @fancaf/live-sdk version             # 验证已上线
npm i @fancaf/live-sdk                        # 消费者安装
```

---

## 六、版本迭代

```bash
npm version patch -m "release: v%s"   # 0.1.0 → 0.1.1（bugfix）
npm version minor -m "release: v%s"   # 0.1.0 → 0.2.0（新功能）
npm version major -m "release: v%s"   # 0.1.0 → 1.0.0（破坏性变更）

git push && git push --tags           # 推代码与 tag
npm run release                       # 再走一遍发布脚本
```

> 注意：`npm version` 会自动创建一次提交和一个 tag。已发布的版本号**不可复用**，即使用 `npm unpublish` 撤回，同一版本号也不能再次发布 —— 撤回后只能发更高版本。

---

## 七、本次随附的配置修正

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
