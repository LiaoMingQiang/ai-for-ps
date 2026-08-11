#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify-ccx: 校验 release/AI-for-PS.ccx 完整性 (zip 结构)"""
import sys
import zipfile

path = sys.argv[1] if len(sys.argv) > 1 else "release/AI-for-PS.ccx"
z = zipfile.ZipFile(path)
names = z.namelist()
bad = z.testzip()
print("ccx entries:", len(names))
print("bad entry:", bad)
print("manifest.json present:", "manifest.json" in names)
print("src/entry.js present:", "src/entry.js" in names)
print("sample js:", [n for n in names if n.startswith("js/")][:3])
sys.exit(0 if (bad is None and "manifest.json" in names and "src/entry.js" in names) else 1)
