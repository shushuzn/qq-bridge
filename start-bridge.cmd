@echo off
rem start-bridge.cmd —— qq-bridge 启动器（本地补充）
rem
rem DSH 桌面版每次启动随机分配 Web 端口（实测 40891 -> 5714 -> 26081），
rem 而 config.json 的 dsh.baseUrl 是写死的、桥接自身也没有端口发现逻辑，
rem 于是每次重启 DSH 后桥接都会静默失联。本启动器先跑 sync-dsh-url.mjs
rem 把 baseUrl 同步到当前实际端口，再启动桥接。
rem
rem 用法：双击本文件，或在本目录执行 start-bridge.cmd
cd /d "%~dp0"
echo [start-bridge] 同步 DSH Web 地址...
node scripts\sync-dsh-url.mjs --write
if errorlevel 1 (
  echo [start-bridge] 警告：未能探测到运行中的 DSH Web，将按 config.json 现有配置继续
)
echo [start-bridge] 启动桥接...
node src\bridge.js
