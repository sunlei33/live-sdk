# live-sdk 发布到 npm —— 本地操作指引

包名：`@fancaf/live-sdk`　版本：`0.1.0`　发布方式：公开（`publishConfig.access: public`）

---

## 一、一次性准备

```bash
cd D:/dev/m-player/live-sdk
npm adduser          # 登录 npm（浏览器授权）
npm whoami           # 确认登录身份，并确认对 @fancaf scope 有发布权限
npm org ls fancaf    # 列出 @fancaf 成员（应能看到你自己；看不到则无发布权）
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
```

脚本 `scripts/publish.sh` 会依次做：

1. **前置检查** —— node/npm、`private` 未开启、`npm whoami` 登录态、scoped 包权限提示、git 工作区与分支
2. **质量门** —— `npm test`（49 条）→ `npm run build` → `npm run verify`（类型契约 + 导出符号 + 运行时冒烟）
3. **预览** —— `npm pack --dry-run`，列出将要上传的每个文件与体积
4. **确认** —— 输入 `y` 才继续
5. **发布** —— `npm publish --ignore-scripts`
6. **（可选）打 tag** —— 询问是否为本次发布创建 `v0.1.0` 并推送到 origin

其他参数：`--skip-gate` 跳过质量门（不推荐）、`--help` 查看用法。

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
