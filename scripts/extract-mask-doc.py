#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""extract-mask-doc: 从下载的 Adobe 官方文档提取 ChannelType 枚举与蒙版相关结论"""
import re
import html as h

t = open("docs-ps-channel.html", encoding="utf-8", errors="ignore").read()
# 属性表
props = re.findall(r'<h3 id="([a-z0-9]+)">', t)
print("Channel props:", props)
# kind 定义
for m in re.findall(r'kind.{0,200}', t)[:4]:
    print("KIND:", h.unescape(m).replace("\n", " ")[:160])
# ChannelType 链接/枚举值
for m in re.findall(r'ChannelType[^<]{0,100}', t)[:8]:
    print("CT:", h.unescape(m)[:120])
for m in re.findall(r'"(?:COMPONENT|MASKED_AREA|SELECTED_AREA|SPOT_COLOR|layerMask|userMask)"', t):
    print("ENUM:", m)
