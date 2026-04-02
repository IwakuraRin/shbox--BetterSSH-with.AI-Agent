# Windows 发布目录

`wails build` 在本机配置为将产物写入 **`build/shbox_windows/bin/`**（由根目录 `scripts/wails-build-to-dir.py` 临时设置 `wails.json` 的 `build:dir`）。

在 **Linux 宿主机上交叉编译 Windows** 时通常需要安装 **MinGW-w64**（供 CGO / WebView2 使用）。若本机构建失败，请在 Windows 上直接执行同一脚本或 `wails build`。

打包命令（在仓库根目录执行）：

```bash
python3 scripts/wails-build-to-dir.py build/shbox_windows windows/amd64 -clean -o shbox-software.exe
```

可执行文件路径示例：`build/shbox_windows/bin/shbox-software.exe`。
