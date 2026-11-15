#!/bin/bash
cd "$(dirname "$0")"
node scripts/bootstrap.mjs
read -r -p "按回车关闭窗口…"
