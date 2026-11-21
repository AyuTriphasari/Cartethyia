#!/usr/bin/env python3
"""Resolve git conflict markers by choosing a side, per hunk or whole file.

Usage: resolve.py <file> [ours|theirs]

Keeps everything outside the markers untouched, so upstream additions in the
same file survive.
"""
import re
import sys

path, side = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as fh:
    lines = fh.readlines()

out, state = [], None
ours, theirs = [], []
for line in lines:
    if line.startswith("<<<<<<<"):
        state, ours, theirs = "ours", [], []
    elif line.startswith("=======") and state == "ours":
        state = "theirs"
    elif line.startswith(">>>>>>>") and state == "theirs":
        out.extend(ours if side == "ours" else theirs)
        state = None
    elif state == "ours":
        ours.append(line)
    elif state == "theirs":
        theirs.append(line)
    else:
        out.append(line)

with open(path, "w", encoding="utf-8") as fh:
    fh.writelines(out)
print(f"{path}: resolved {side}")
