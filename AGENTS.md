# Repository Guidelines

## 项目结构与模块组织

本仓库是一个无需构建的 Tampermonkey 用户脚本项目。

- `script.user.js`：全部运行时代码，包括 Amazon 页面数据提取、A+ 截图、飞书/本地 API 同步及配置界面。
- `README.md`：安装方法、飞书权限配置、支持字段和版本记录。

新增功能时优先放入现有的对应分区（如“数据提取函数”或“飞书 API”），避免引入不必要的目录或依赖。若添加自动化测试，再统一放入 `tests/`。

## 构建、测试与本地开发

项目没有编译步骤、包管理器或测试脚本。常用检查方式如下：

```powershell
git diff --check
git diff -- script.user.js
```

前者检查空白错误，后者用于提交前审阅脚本改动。本地运行时，将 `script.user.js` 导入 Tampermonkey，打开受支持站点的商品详情页（例如 `/dp/<ASIN>`），验证悬浮按钮、字段采集和目标同步流程。修改 `@match`、`@grant`、`@connect` 或外部库时，必须重新安装脚本并复测权限。

## 编码风格与命名约定

沿用现有原生 JavaScript 风格：4 空格缩进、单引号、语句末尾分号，以及 `const`/`let`，不要使用 `var`。函数采用 `camelCase`（如 `getMarketCode`），常量采用 `UPPER_SNAKE_CASE`（如 `CONFIG_KEY`）。DOM 选择器和多语言正则应保持局部、直观，并为不明显的站点差异添加简短注释。不要仅为一个调用点创建抽象层。

## 测试指南

当前没有自动化测试或覆盖率门槛。每次修改至少手工验证一个相关站点和一个回归站点；涉及 BSR、日期或品牌解析时，应覆盖受影响语言。检查缺失 DOM、空字段和请求失败时是否给出明确错误，而不是静默失败。若引入测试，测试名称应描述行为，例如 `parses Spanish BSR without prefix`。

## 提交与拉取请求

历史提交采用 Conventional Commits 风格：`feat:`、`fix:`、`refactor:`、`docs:`，常附版本号和简短中文原因。保持一次提交只解决一个问题，例如 `fix: 适配意大利站日期格式`。

拉取请求应说明变更原因、受影响站点、手工验证步骤及结果，并关联相关 issue。界面变化附截图；采集或同步变化附脱敏示例。不得提交飞书 App Secret、访问令牌、真实表格链接或客户数据。
