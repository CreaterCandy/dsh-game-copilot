@echo off
rem 一键启动副驾守护（按住 Caps Lock 说话）。%~dp0 = 本脚本所在目录，换盘/换用户名都能跑。
start "" "%~dp0runtime\venv\Scripts\pythonw.exe" "%~dp0runtime\ptt_voice.pyw"
