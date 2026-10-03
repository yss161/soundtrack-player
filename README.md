# 声轨 Soundtrack · 音乐播放器 GUI

基于 [musicdl](https://github.com/CharlesPikachu/musicdl) 的现代化 Web 音乐播放器：多源搜索 / 在线试听 / 同步歌词 / 高速下载。

## 独立部署（推荐）

克隆或下载本仓库后，只需两步即可使用：

```
1. 下载 musicdl 源码: https://github.com/CharlesPikachu/musicdl/archive/refs/heads/master.zip
   解压，把得到的 musicdl-master 文件夹整个放进本项目目录
2. 双击 启动播放器.bat
```

- 首次运行会自动安装依赖（使用清华镜像，约 1-3 分钟），之后每次双击直接启动
- 启动后会自动打开浏览器访问 http://127.0.0.1:5000，关闭命令行窗口即退出
- musicdl 源码也可以放在 `vendor/` 下，或与本目录同级，程序会自动识别

- 首次运行会自动安装依赖（使用清华镜像，约 1-3 分钟），之后每次双击直接启动
- 启动后会自动打开浏览器访问 http://127.0.0.1:5000，关闭命令行窗口即退出
- musicdl 源码也可以放在 `gui/vendor/` 下，或与 `gui` 同级，程序会自动识别

目录结构（步骤 2 完成后）：

```
gui/
├── app.py               后端
├── static/              前端
├── requirements.txt     依赖清单
├── 启动播放器.bat        一键启动（自动找 Python、首次自动装依赖）
├── musicdl-master/      ← musicdl 源码解压到这里
│   └── musicdl/         ← Python 包（程序自动加载这份源码）
└── downloads/           下载输出目录（自动创建）
```

## 在本仓库内运行（开发模式）

```bash
# 需要 Python 3.10+（本项目在 3.14 上开发测试）
py -3.14 -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
py -3.14 app.py
```

浏览器打开 **http://127.0.0.1:5000** 可用 `PORT=8080 py -3.14 app.py` 更换端口；`NO_BROWSER=1` 禁止自动开浏览器。

> 需要能正常访问各音乐平台的网络环境。本工具仅供学习研究，请尊重版权与各平台服务条款。

## 功能

- **流式搜索**：多音源并发，结果逐条实时浮现（SSE），单源看门狗超时不拖垮界面；每源状态实时显示（搜索中 / 完成 / 超时 / 出错）。
- **即点即放**：搜索时已解析直链，播放走后端代理（支持 Range 拖动进度）；链接过期自动重新搜索续期。
- **完整播放器**：播放/暂停、上一首/下一首、进度条与音量条拖动、缓冲指示、播放模式（列表循环/单曲循环/随机）、播放队列管理、Web Audio 实时频谱。
- **同步歌词**：LRC 逐行高亮滚动，点击歌词行跳转进度，唱片封面随播放旋转。
- **收藏**：本地持久化（localStorage），收藏列表可一键全部播放；链接过期自动续期。
- **搜索历史**：输入框聚焦展示最近 10 条记录，可清空。
- **下载管理**：分块下载 + 实时进度/速度（SSE）；下载中可随时**终止**（断流并清理临时文件）；完成后可**保存到本地**、**打开文件夹**（资源管理器定位到文件）或**删除文件**；文件保存在 `gui/downloads/<音源>/`，服务器启动时自动清理残留的 .part 临时文件。
- **系统媒体键**：MediaSession 支持，锁屏/键盘媒体键可控制播放与切歌。
- **快捷键**：`空格` 播放/暂停 · `Alt+←/→` 切歌 · `M` 静音 · `L` 歌词 · `Esc` 关闭面板。

## 音源

默认只启用**咪咕音乐**（稳定、快），网易云 / 酷我 / QQ / 酷狗 / 千千 / GD聚合 在顶栏一键启用。

如需会员音质，可在 `app.py` 的 `MANAGER._build()` 里给对应源加 `default_search_cookies`，用法同 musicdl 官方文档。

## 结构

```
gui/
├── app.py             Flask 后端: 流式搜索(SSE) / 音频代理(Range) / 封面代理 / 下载管理
│                      安全加固: 上游 URL SSRF 校验 + TLS 校验 / 下载路径白名单+realpath 防穿越
├── static/
│   ├── index.html     界面结构 (侧边栏 / 搜索 / 收藏 / 队列 / 下载 / 歌词 / 播放条)
│   ├── style.css      深色"录音棚"主题
│   └── app.js         前端逻辑: 流式渲染 / 频谱 / 同步歌词 / 队列 / 收藏 / 下载
├── requirements.txt   依赖清单（musicdl 依赖 + flask）
├── 启动播放器.bat      Windows 一键启动
└── downloads/         下载输出目录（按音源分子目录，自动创建）
```

## 主要调整项（app.py 顶部常量）

- `SUPPORTED_SOURCES` — 增删音源、改默认开关
- `SEARCH_SIZE_PER_SOURCE` — 每源尝试解析的歌曲数（越大越慢）
- `PER_SOURCE_TIMEOUT` — 单源看门狗超时秒数

## 致谢

基于 [CharlesPikachu/musicdl](https://github.com/CharlesPikachu/musicdl) 构建，所有搜索与音频解析逻辑均来自 musicdl。
