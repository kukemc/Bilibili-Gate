# 浮动预览弹幕版

基于 magicdawn/Bilibili-Gate，保留 MIT 许可及上游署名。

## 安装

1. 浏览器安装 Tampermonkey 或 Violentmonkey。
2. 安装：https://raw.githubusercontent.com/kukemc/Bilibili-Gate/refs/heads/release-danmaku/bilibili-gate.user.js
3. **禁用原版 Bilibili-Gate**，然后刷新 B站页面。此 fork 使用独立名称/namespace/更新地址，不覆盖原版设置，也不会自动迁移原版设置。
4. 视频卡片打开「浮动预览」，自动显示该视频 CID 对应弹幕。
5. 左上角「弹幕开/关」展开设置：开关、透明度、字号、显示区域。设置持久化。
6. 右上角新增「全屏」按钮使用容器全屏，包含弹幕；视频原生全屏和系统画中画不包含 Canvas 弹幕。

## 已实现

- B站 Web protobuf 弹幕接口，按 360 秒分段加载；当前/上一/下一段有界预取，不在闲置卡片发请求。
- CID 与播放地址共同返回，修复显式分 P CID 被首 P 覆盖及缓存键缺少 CID 的问题。
- 64 位弹幕 ID 保精度、UTF-8 文本、颜色、字号、模式、时间解析。
- 模式 1/2/3 滚动、4 底部、5 顶部、6 逆向。描边及防碰撞轨道。
- 模式 7 数组格式定位：透明度、寿命、坐标、延迟移动、Z 旋转、绝对 M/L 路径；Y 旋转为二维正交近似。
- 使用媒体 currentTime 驱动，播放/暂停/拖动/倍速/循环同步；暂停后 seek 仍重绘。
- ResizeObserver 与 DPR 适配；关闭预览或禁用弹幕取消请求、释放事件与 RAF。
- 成功结果 5 分钟有界缓存，错误不缓存；加载状态/空弹幕/失败重试，不阻塞视频播放。
- Canvas 纯文本，不将弹幕作为 HTML 或脚本执行。

## 明确边界

这不是 B站官方播放器的完整复刻，**不能称为所有弹幕格式的完整支持**：

- 模式 8 代码弹幕不执行；模式 9 BAS 不支持。
- 高级弹幕未实现曲线/相对路径、指定字体、完整三维透视，寿命最多 30 秒。
- 不包含发送弹幕、历史日期弹幕、官方账号屏蔽列表、云屏蔽规则、智能防挡字幕或人像蒙版。
- 普通滚动寿命 8 秒，固定弹幕 4 秒；活跃弹幕最多 160 条；拥挤时舍弃无法分配轨道的普通弹幕。
- 单条文本最多 2048 字符/16 行；大数据首次布局会占用主线程。
- 使用 Web 当前弹幕分段接口，不承诺返回视频全部历史弹幕。接口风控/网络/权限错误会显示重试提示。
- 原生视频全屏/系统画中画无法带上兄弟 Canvas；请用新增容器全屏按钮。

## 验证

- `pnpm build:scss`（同时修复上游 Windows 单引号 glob 兼容问题）。
- `pnpm exec tsc -b --noEmit` 通过。
- `pnpm test`：74 项通过，其中新增数据层 34 项、渲染器 11 项。
- 新增/修改代码限定 ESLint 检查及 production Vite 构建通过。
- 浏览器真实 B站视频 `BV1FetJ6fE6H` / CID `41520009007` 分段接口 HTTP 200；解码得到顶部弹幕，Canvas 非透明像素 13668；seek 到无弹幕时间后为 0，回跳恢复为 13668。
- 浏览器验证使用独立 smoke harness + 同一数据/渲染模块，并非脚本管理器完整安装后的端到端验收。截图已生成，但执行模型不具备图像输入能力，未做人工视觉判读。

## 构建

Node.js + 仓库指定 pnpm 版本：

```sh
pnpm install --frozen-lockfile
pnpm build:scss
pnpm exec tsc -b --noEmit
pnpm test
```

PowerShell 生成发布包：

```powershell
$env:RELEASE='1'
$env:CI='1'
pnpm build:vite
```

产物 `dist/bilibili-gate.user.js` 和 `dist/bilibili-gate.meta.js` 发布到本 fork 的 `release-danmaku` 分支。不要运行默认 `pnpm build` 作为一次性 CI 构建，它会继续启动 preview 服务。
