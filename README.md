# QX Packet Unpacker

一个 macOS 桌面小工具，用来把 Quantumult X 导出的抓包目录自动解包、合并并生成可读的 `.txt` 文件。

## 功能

- 识别 `1/basic`、`1/request_headers`、`1/response_body` 这类 qx 导出结构。
- 自动处理响应体的 `Transfer-Encoding: chunked`。
- 自动解压 `Content-Encoding: gzip`、`br`、`deflate`。
- JSON 自动格式化，二进制内容用 Base64 保留。
- 支持桌面 app 操作，也支持命令行批量转换。

## 运行

```bash
npm install
npm start
```

## 网页端运行

网页端是纯静态文件，放在 `docs/`，适合直接挂到 GitHub Pages。

本地预览：

```bash
npm run web
```

打开 `http://127.0.0.1:4173` 后选择 qx 抓包导出目录即可。处理过程都在浏览器本机完成，不会上传文件。

部署到 GitHub Pages：

1. 把项目推到 GitHub。
2. 进入仓库 `Settings` -> `Pages`。
3. `Build and deployment` 选择 `Deploy from a branch`。
4. Branch 选择 `main`，目录选择 `/docs`。
5. 保存后等待 Pages 发布。

## 命令行转换

```bash
npm run convert -- "qx 抓包原始文件示例" --out "整理结果.txt"
```

## 打包 mac app

```bash
npm run package:mac
```

打包产物会在 `dist/` 目录下生成。
