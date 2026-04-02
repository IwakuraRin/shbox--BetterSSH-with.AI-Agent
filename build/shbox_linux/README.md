# Linux 发布目录

`wails build` 在本机配置为将产物写入 **`build/shbox_linux/bin/`**（由根目录 `scripts/wails-build-to-dir.py` 临时设置 `wails.json` 的 `build:dir`）。

打包命令（在仓库根目录执行）：

```bash
python3 scripts/wails-build-to-dir.py build/shbox_linux linux/amd64 -clean -o shbox-software
```

可执行文件路径示例：`build/shbox_linux/bin/shbox-software`。
