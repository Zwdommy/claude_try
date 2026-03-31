# 像素拼豆生成器 / Pixel Bead Art Generator

将图片转换为像素拼豆风格，并生成可 3D 打印的彩色模型。

Upload an image → AI pixel analysis → 4 resolution previews → 3D printable snap-fit bead model with dual-color 3MF export.

---

## Features

### 像素处理
- 上传图片（JPG / PNG / SVG），自动生成 4 种像素密度预览（16 / 24 / 32 / 48 格）
- 「小鼻嘎模式」限制像素点 ≤ 100，适合快速打印
- 点击任意预览图 → Gemini Vision API 分析像素颜色，输出 RGB 颜色矩阵

### 3D 模型生成
- 基于 [manifold-3d](https://github.com/elalish/manifold) WASM 做 CSG 布尔运算
- 每个像素点生成一个空心管（WALL_T = 1 mm）+ 顶部彩色表面层
- 相邻像素通过**箭头形卡扣（snap-fit plug/slot）**互相连接，无需胶水

### 卡扣参数（全部可实时调节）
| 参数 | 说明 | 默认值 |
|------|------|--------|
| 零件高度 | 单个像素块的总高度 | 37.625 mm |
| 插宽度 | 插头颈部宽度（等比缩放） | 4.263 mm |
| 头部倍率 | 箭头头部相对颈部的放大倍率 | 1× |
| 插高度 | 插头在 Z 轴方向的高度 | 6.1 mm |
| 表面厚度 | 顶部彩色层厚度 | 0.8 mm |

> 滑块实时响应，自动重新生成（带 pending/generating 节流，避免 WASM 队列堆积）

### 导出
- **合并 STL** — 所有零件合并为单个 STL 文件
- **各零件 STL** — 每个像素单独一个 STL（ZIP 打包）
- **彩色 3MF** — 包含颜色信息的 3MF 文件，可直接导入拓竹 / Bambu Studio
  - 零件主体使用默认材质颜色
  - 顶部表面层使用 Gemini 识别的像素颜色
  - 颜色以 `<basematerials>` 索引写入 3MF XML

---

## 多色打印说明（拓竹 / Bambu AMS）

AMS 每个单元支持 4 色；像素图片可能包含更多不同颜色。当前导出会将所有颜色写入 3MF。建议导入 Bambu Studio 后手动将相近颜色合并到对应耗材槽。

---

## 项目结构

```
pixel-bead-art/
├── index.html      # 主应用入口，含参数面板
├── main.js         # 主逻辑：图片处理、Gemini 调用、3D 触发
├── model3d.js      # 3D 核心：manifold-3d CSG、Three.js 渲染、3MF 导出
├── style.css       # UI 样式
├── test3x3.html    # 独立 3×3 测试页（含 X-ray 透视、颜色选择器、相机预设）
└── public/         # 静态资源
```

---

## 快速开始

```bash
cd pixel-bead-art
npm install
npm run dev
# 访问 http://localhost:5173
```

### 测试页

```
http://localhost:5173/test3x3.html
```

- 可独立测试卡扣尺寸、X-ray 透视模式、各角度相机预设
- 支持每个像素格自定义颜色

---

## 技术栈

- **manifold-3d** — WASM CSG 布尔运算引擎
- **Three.js** — WebGL 实时渲染
- **fflate** — 纯 JS ZIP / 3MF 打包
- **Gemini Vision API** — 像素颜色识别
- **Vite** — 构建工具
